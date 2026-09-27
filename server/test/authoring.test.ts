import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { isPublicHttpsUrl } from "../src/engine/http.ts";
import { load } from "../src/engine/load.ts";
import { API_KEY } from "./fixtures.ts";
import { loopbackOrPublic, resultText, startHarness, stateOf, type Harness, type Setup } from "./harness.ts";

const PINNED_DIGEST = /sha256: "(sha256:[0-9a-f]{64})"/.exec(readFileSync(new URL("fixtures/stock-check.stepfile.yaml", import.meta.url), "utf8"))?.[1];

const GREETING = `stepgate: "1"
id: greeting
inputs:
  type: object
  required: [name]
  properties:
    name: { type: string }
steps:
  - id: greet
    instructions: "Greet {{inputs.name}}."
    produces:
      type: object
      required: [greeting]
      properties:
        greeting: { type: string }
    gates:
      - id: names-them
        predicate: { in: [{ var: inputs.name }, { var: output.greeting }] }
        message: the greeting must contain the name
    retries: 1
`;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(setup: Omit<Setup, "actions"> = {}): Promise<Harness> {
  harness = await startHarness({ ...setup, actions: [] });
  return harness;
}

async function use(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await (harness as Harness).client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("authoring tools", () => {
  it("gives an agent the workflow, the format reference and the JSON Schema in one guide", async () => {
    await start();

    const guide = resultText(await use("stepgate_guide", {}));

    expect(guide).toContain("stepgate_inspect_api");
    expect(guide).toContain("# Writing a stepfile\n");
    expect(guide).toContain('"$id": "https://raw.githubusercontent.com/Chaarangan/stepgate/main/server/schema/stepfile.schema.json"');
  });

  it("lists catalog examples with the keys each needs, and returns one that loads", async () => {
    await start();

    const list = resultText(await use("stepgate_examples", {}));
    const one = resultText(await use("stepgate_examples", { name: "market-research" }));
    const missing = await use("stepgate_examples", { name: "no-such-entry" });

    expect(list).toContain("- market-research (marketing; keys: tavily):");
    expect(load(/```yaml\n([\s\S]*?)\n```/.exec(one)?.[1] ?? "").document.id).toBe("market-research");
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toMatch(/^UnknownStepfile: /);
  });

  it("validates a draft: every issue with its path, or its identity and whether it can be tried", async () => {
    await start();

    const broken = await use("stepgate_validate", { stepfile: GREETING.replace('stepgate: "1"', 'stepgate: "2"') });
    const valid = resultText(await use("stepgate_validate", { stepfile: GREETING }));
    const keyed = resultText(await use("stepgate_validate", {
      stepfile: GREETING.replace("steps:", "credentials:\n  crm: { kind: bearer, hosts: [api.example.com], description: CRM. }\nsteps:"),
    }));

    expect(broken.isError).toBe(true);
    expect(resultText(broken)).toContain("- /stepgate: must be equal to constant");
    expect(valid).toContain(`identity: ${load(GREETING).identity}`);
    expect(valid).toContain("stepgate_try can run it.");
    expect(keyed).toContain("stepgate_try will refuse it:\n- it declares credential crm, which the operator has not granted to drafts");
  });

  it("inspects an OpenAPI document: the digest to pin, its operations, and the arguments and response a step will see", async () => {
    const { api } = await start();
    const url = `${api.origin}/openapi.json`;

    const listing = resultText(await use("stepgate_inspect_api", { kind: "openapi", url }));
    const detail = resultText(await use("stepgate_inspect_api", { kind: "openapi", url, operations: ["getFormattedItem", "getItem", "nope"] }));

    expect(listing).toContain(`sha256: ${PINNED_DIGEST} (pin this`);
    expect(listing).toContain("- getItem: GET /items/{id}.");
    expect(listing).toContain("security schemes: ");
    const definitions = JSON.parse(/left out:\n(\[[\s\S]*?\n\])/.exec(detail)?.[1] ?? "[]") as Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> }; response: object | null }>;
    expect(definitions.map((definition) => definition.name)).toEqual(["getFormattedItem", "getItem"]);
    expect(definitions[0]?.inputSchema.properties).toEqual({ id: { type: "string", description: "The item code, such as K-1." } });
    expect(definitions[1]?.response).toMatchObject({ properties: { stock: { type: "integer" } } });
    expect(detail).toContain("Not in the document: nope");
  });

  it("lists operations with no operationId, and returns their definition to copy inline", async () => {
    const { api } = await start();
    const url = `${api.origin}/openapi.json`;

    const listing = resultText(await use("stepgate_inspect_api", { kind: "openapi", url }));
    const detail = resultText(await use("stepgate_inspect_api", { kind: "openapi", url, operations: ["GET /health"] }));

    expect(listing).toContain("1 operations have no operationId");
    expect(listing).toContain("- GET /health: Report whether the catalogue is up.");
    expect(detail).toContain("These have no operationId. To expose one, declare the tool with an inline openapi.document");
    expect(detail).toContain('"summary": "Report whether the catalogue is up."');
  });

  it("reports an MCP server that needs a key instead of sending one", async () => {
    const { mcp } = await start();

    const result = await use("stepgate_inspect_api", { kind: "mcp", url: `${mcp.origin}/mcp` });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^ToolCallFailed: .*could not list tools/);
    expect(mcp.received.every((request) => request.headers.authorization === undefined)).toBe(true);
  });

  it("refuses to inspect or try anything on a loopback address outside tests, before contacting it", async () => {
    const { api } = await start({ drafts: () => ({ urlAllowed: isPublicHttpsUrl, credentials: new Map(), settings: new Set() }) });
    const localDraft = GREETING.replace("steps:", `tools:\n  local:\n    openapi: { server: "${api.origin}", url: "${api.origin}/openapi.json", sha256: "${PINNED_DIGEST}" }\n    exposes: [getItem]\nsteps:`);

    const inspected = resultText(await use("stepgate_inspect_api", { kind: "openapi", url: `${api.origin}/openapi.json` }));
    const tried = resultText(await use("stepgate_try", { stepfile: localDraft, inputs: { name: "Ada" } }));

    expect(inspected).toMatch(/^UrlNotPublic: /);
    expect(tried).toMatch(/^DraftRefused: draft refused: tool local must use a public https URL/);
    expect(api.received).toEqual([]);
  });

  it("runs a keyless draft from its text, driven with stepgate_submit like any run", async () => {
    await start();

    const first = await use("stepgate_try", { stepfile: GREETING, inputs: { name: "Ada" } });
    const { run } = stateOf(first);
    const rejected = await use("stepgate_submit", { run, output: { greeting: "Hello there" } });
    const finished = await use("stepgate_submit", { run, output: { greeting: "Hello, Ada" } });

    expect(resultText(first)).toMatch(/step 1 of 1: greet\.[\s\S]*Greet Ada\./);
    expect(stateOf(rejected)).toMatchObject({ state: "running", attempts_left: 1 });
    expect(resultText(rejected)).toContain("names-them: the greeting must contain the name");
    expect(stateOf(finished)).toMatchObject({ state: "finished", outputs: { greet: { greeting: "Hello, Ada" } } });
  });

  it("refuses a draft that declares a credential the operator did not grant, so a draft is never handed a key unasked", async () => {
    const { api, records } = await start();
    const keyed = GREETING.replace("steps:", "credentials:\n  crm: { kind: bearer, hosts: [api.example.com], description: CRM. }\nsteps:");

    const result = await use("stepgate_try", { stepfile: keyed, inputs: { name: "Ada" } });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^DraftRefused: draft refused: it declares credential crm, which the operator has not granted/);
    expect(records).toEqual([]);
    expect(api.received).toEqual([]);
  });

  it("runs a draft with a credential the operator granted, and refuses one that lists another host", async () => {
    const { api } = await start({ drafts: ({ catalogueHost }) => ({ urlAllowed: loopbackOrPublic, credentials: new Map([["catalogue", [catalogueHost]]]), settings: new Set() }) });
    const keyed = (hosts: string) => `stepgate: "1"
id: keyed-stock
inputs: { type: object, properties: {} }
credentials:
  catalogue: { kind: api_key, hosts: [${hosts}], description: Reads the catalogue. }
tools:
  catalogue:
    openapi: { server: "${api.origin}", url: "${api.origin}/openapi.json", sha256: "${PINNED_DIGEST}" }
    credential: catalogue
    exposes: [getItem]
steps:
  - id: stock
    tools: [getItem]
    instructions: Look up item K-1.
    produces: { type: object, required: [stock], properties: { stock: { type: integer } } }
    gates:
      - id: from-catalogue
        message: stock must come from getItem
        predicate: { in: [{ var: output.stock }, { map: [{ var: calls }, { var: result.stock }] }] }
`;

    const first = await use("stepgate_try", { stepfile: keyed(`"${api.host}"`), inputs: {} });
    const { run } = stateOf(first);
    await use("stepgate_call", { run, operation: "getItem", arguments: { id: "K-1" } });
    const finished = await use("stepgate_submit", { run, output: { stock: 4 } });
    const widened = await use("stepgate_try", { stepfile: keyed(`"${api.host}", api.example.com`), inputs: {} });

    expect(stateOf(finished)).toMatchObject({ state: "finished", outputs: { stock: { stock: 4 } } });
    expect(api.received.find((request) => request.path === "/items/K-1")?.headers["x-api-key"]).toBe(API_KEY);
    expect(resultText(widened)).toContain(`credential catalogue lists api.example.com, but the operator granted it only for ${api.host}`);
  });
});

const SKILL = `---
name: release-notes
description: Write release notes from the pull requests merged since the last tag.
---
# Release notes

1. List the pull requests merged since the last tag. You MUST include every one.
2. Group them by label. Never invent a label.
3. Write the notes in Markdown.
`;

const SOP = `# Incident review

## Collect the timeline
Pull every alert for the incident window. The timeline SHALL list each alert once.

## Find the cause
Name the change that caused it.

## Write the review
Summarise the impact. The review MUST link the incident ticket.
`;

describe("outlining a procedure", () => {
  it("turns a SKILL.md into one step per numbered item, with each rule it states as a gate to write", async () => {
    await start();

    const skeleton = parseYaml(extractYaml(resultText(await use("stepgate_outline", { procedure: SKILL })))) as { id: string; description: string; steps: Array<{ id: string; instructions: string; gates: string[] }> };

    expect(skeleton).toMatchObject({ id: "release-notes", description: "Write release notes from the pull requests merged since the last tag." });
    expect(skeleton.steps.map((step) => [step.id, step.gates])).toEqual([
      ["step-1", ["TODO(gate): You MUST include every one."]],
      ["step-2", ["TODO(gate): Never invent a label."]],
      ["step-3", ["TODO(gate): the procedure states no rule for this step; check a real property of its output"]],
    ]);
    expect(skeleton.steps[0]?.instructions).toBe("List the pull requests merged since the last tag. You MUST include every one.");
  });

  it("turns an SOP into one step per second-level heading, named after it", async () => {
    await start();

    const skeleton = parseYaml(extractYaml(resultText(await use("stepgate_outline", { procedure: SOP })))) as { id: string; steps: Array<{ id: string; gates: string[] }> };

    expect(skeleton.id).toBe("incident-review");
    expect(skeleton.steps.map((step) => step.id)).toEqual(["collect-the-timeline", "find-the-cause", "write-the-review"]);
    expect(skeleton.steps[0]?.gates).toEqual(["TODO(gate): The timeline SHALL list each alert once."]);
    expect(skeleton.steps[2]?.gates).toEqual(["TODO(gate): The review MUST link the incident ticket."]);
  });

  it("uses a skill's numbered steps under a heading, and ignores lines inside code fences", async () => {
    await start();
    const procedure = `# Deploy\n\n## Steps\n\n1. Build the image.\n2. Push it. You MUST tag it with the commit.\n\n\`\`\`sh\n## not a heading\n3. not a step\n\`\`\`\n`;

    const skeleton = parseYaml(extractYaml(resultText(await use("stepgate_outline", { procedure })))) as { steps: Array<{ id: string; instructions: string }> };

    expect(skeleton.steps.map((step) => [step.id, step.instructions])).toEqual([["step-1", "Build the image."], ["step-2", "Push it. You MUST tag it with the commit."]]);
  });

  it("refuses a procedure whose frontmatter is not a mapping, or that is missing", async () => {
    await start();

    const scalar = await use("stepgate_outline", { procedure: "---\njust a line\n---\n1. Do it.\n2. Check it.\n" });
    const missing = await use("stepgate_outline", {});

    expect(scalar.isError).toBe(true);
    expect(resultText(scalar)).toMatch(/^ProcedureInvalid: .*frontmatter/);
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toMatch(/^ProcedureInvalid: .*procedure/);
  });

  it("validates a skeleton by listing every TODO marker still to write, by path", async () => {
    await start();
    const skeleton = extractYaml(resultText(await use("stepgate_outline", { procedure: SOP })));

    const report = await use("stepgate_validate", { stepfile: skeleton });

    expect(report.isError).toBe(true);
    expect(resultText(report)).toContain("- /inputs: TODO(inputs)");
    expect(resultText(report)).toContain("- /steps/0/produces: TODO(produces)");
    expect(resultText(report)).toContain("- /steps/2/gates/0: TODO(gate): The review MUST link the incident ticket.");
  });
});

function extractYaml(text: string): string {
  const yaml = /```yaml\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (yaml === undefined) {
    throw new Error(`stepgate_outline returned no YAML block: ${text}`);
  }
  return yaml;
}
