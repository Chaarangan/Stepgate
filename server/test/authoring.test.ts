import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
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
