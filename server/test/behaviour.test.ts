import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/engine/types.ts";
import { VERSION } from "../src/version.ts";
import { API_KEY, BASIC_CREDENTIAL, MCP_TOKEN } from "./fixtures.ts";
import { GOOD_STOCK, GOOD_SUMMARY, resultText, startHarness, use, type Harness, type Setup } from "./harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(setup: Setup): Promise<Harness> {
  harness = await startHarness(setup);
  return harness;
}

const STOCK_WITH_TOOLS = [
  [
    { type: "tool_use", id: "t1", name: "getItem", input: { id: "K-1" } },
    { type: "tool_use", id: "t2", name: "lookup", input: { query: "Acme" } },
  ],
  GOOD_STOCK,
  GOOD_SUMMARY,
] as Setup["turns"];

function steps(stepfile: JsonObject): JsonObject[] {
  return stepfile.steps as JsonObject[];
}

const badCount = (id: string) => use(id, "submit", { name: "Blue kettle", count: 0, supplier: "Acme" });

describe("secrecy and isolation", () => {
  it("never shows the model a credential, and keeps credentials out of the ledger", async () => {
    const { call, sampled, records } = await start({ turns: STOCK_WITH_TOOLS });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    for (const secret of [API_KEY, MCP_TOKEN]) {
      expect(JSON.stringify(sampled)).not.toContain(secret);
      expect(JSON.stringify(records)).not.toContain(secret);
    }
  });

  it("gives each step a fresh context holding only its own instructions and tools", async () => {
    const { call, sampled } = await start({ turns: STOCK_WITH_TOOLS });

    await call({ item: "K-1" });

    const summaryTurn = sampled[2];
    expect(summaryTurn?.messages).toEqual([{ role: "user", content: { type: "text", text: "Summarise: Blue kettle has 4 in stock." } }]);
    expect(summaryTurn?.tools?.map((tool) => tool.name)).toEqual(["submit"]);
    expect(JSON.stringify(summaryTurn)).not.toContain("Find item");
    expect(JSON.stringify(sampled)).not.toContain("stock-check");
  });
});

describe("gates", () => {
  it("sends a failed gate's diagnosis back to the model and accepts the corrected submission", async () => {
    const { call, sampled, records } = await start({ turns: [badCount("b1"), GOOD_STOCK, GOOD_SUMMARY] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    const feedback = sampled[1]?.messages.at(-1);
    expect(feedback).toMatchObject({ role: "user", content: [{ type: "tool_result", toolUseId: "b1", isError: true }] });
    expect(JSON.stringify(feedback)).toMatch(/count-positive[\s\S]*count must be positive/);
    const verdicts = records.filter((record) => record.type === "gate" && record.step === "stock").map((record) => [record.attempt, record.verdict]);
    expect(verdicts).toEqual([[1, "fail"], [2, "pass"]]);
  });

  it("records a turn that ends without submit as a failed submit gate, and asks again", async () => {
    const { call, sampled, records } = await start({
      turns: [[{ type: "text", text: "The kettle is in stock." }], GOOD_STOCK, GOOD_SUMMARY] as Setup["turns"],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(records).toContainEqual(expect.objectContaining({ type: "gate", step: "stock", attempt: 1, gate: "submit", verdict: "fail" }));
    expect(sampled[1]?.messages.at(-1)).toMatchObject({ role: "user", content: { type: "text", text: expect.stringContaining("submit") } });
  });

  it("halts with GateFailed naming the gate once the step's retries are used up", async () => {
    const { call, records } = await start({ turns: [badCount("b1"), badCount("b2")] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^GateFailed: step stock failed gates: count-positive/);
    expect(records.at(-1)).toMatchObject({ type: "run_failed", error: "GateFailed" });
  });

  it("asks an http verifier and feeds its failing verdict back to the model", async () => {
    const { call, sampled, api } = await start({
      edit: (stepfile, addresses) => {
        (stepfile.tools as JsonObject).checker = { verifier: { url: addresses.checker } };
        (steps(stepfile)[0] as JsonObject).gates = [{ id: "enough", http: { tool: "checker" } }];
      },
      turns: [use("v1", "submit", { name: "Blue kettle", count: 2, supplier: "Acme" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(sampled[1]?.messages.at(-1))).toMatch(/enough[\s\S]*count 2 is below 3/);
    const verifications = api.received.filter((request) => request.path === "/verify").map((request) => JSON.parse(request.body) as JsonObject);
    expect(verifications).toHaveLength(2);
    expect(verifications[0]).toMatchObject({ stepfile: "stock-check", step: "stock", gate: "enough", inputs: { item: "K-1" }, output: { count: 2 } });
  });
});

describe("evidence", () => {
  const countMatchesCatalogue = (runbook: JsonObject) => {
    (steps(runbook)[0] as JsonObject).gates = [{
      id: "count-from-catalogue",
      message: "count must be the stock level the catalogue returned",
      predicate: { in: [{ var: "output.count" }, { map: [{ filter: [{ var: "calls" }, { "==": [{ var: "tool" }, "getItem"] }] }, { var: "result.stock" }] }] },
    }];
  };

  it("rejects a value no tool returned, and accepts the one the API gave", async () => {
    const { call, sampled } = await start({
      edit: countMatchesCatalogue,
      turns: [
        use("e1", "getItem", { id: "K-1" }),
        use("e2", "submit", { name: "Blue kettle", count: 5, supplier: "Acme" }),
        GOOD_STOCK,
        GOOD_SUMMARY,
      ],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(sampled[2]?.messages.at(-1))).toContain("count must be the stock level the catalogue returned");
  });

  it("cannot pass an evidence gate without calling the tool", async () => {
    const { call } = await start({ edit: countMatchesCatalogue, turns: [GOOD_STOCK, GOOD_STOCK] });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^GateFailed: step stock failed gates: count-from-catalogue/);
  });

  it("gives gates a text result as text", async () => {
    const { call } = await start({
      edit: (runbook) => void ((steps(runbook)[0] as JsonObject).gates = [{
        id: "city-from-lookup",
        message: "supplier city must come from the lookup",
        predicate: { in: ["Leeds", { reduce: [{ var: "calls" }, { cat: [{ var: "accumulator" }, { var: "current.result" }] }, ""] }] },
      }]),
      turns: STOCK_WITH_TOOLS,
    });

    expect((await call({ item: "K-1" })).isError).toBeFalsy();
  });
});

describe("operator settings", () => {
  const catalogueFromSetting = (stepfile: JsonObject) => {
    stepfile.settings = { "catalogue-port": { description: "Port of the catalogue API.", pattern: "^[0-9]{2,5}$" } };
    const openapi = ((stepfile.tools as JsonObject).catalogue as JsonObject).openapi as JsonObject;
    openapi.server = "http://127.0.0.1:{catalogue-port}";
    openapi.url = "http://127.0.0.1:{catalogue-port}/openapi.json";
    ((stepfile.credentials as JsonObject).catalogue as JsonObject).hosts = ["127.0.0.1:{catalogue-port}"];
  };

  it("fills a {setting} in tool and credential hosts from the operator's value", async () => {
    const { call, api } = await start({ edit: catalogueFromSetting, settings: ({ cataloguePort }) => ({ "catalogue-port": cataloguePort }), turns: STOCK_WITH_TOOLS });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(api.received.find((request) => request.path === "/items/K-1")?.headers["x-api-key"]).toBe(API_KEY);
  });

  it("fails preflight when a setting is missing, or its value could change the host", async () => {
    const missing = await start({ edit: catalogueFromSetting, turns: [] });
    expect(resultText(await missing.call({ item: "K-1" }))).toContain("PreflightFailed: preflight failed for setting catalogue-port");
    await missing.close();
    harness = undefined;

    const hostile = await start({ edit: catalogueFromSetting, settings: () => ({ "catalogue-port": "80@evil.example" }), turns: [] });
    const text = resultText(await hostile.call({ item: "K-1" }));
    expect(text).toContain("PreflightFailed: preflight failed for setting catalogue-port");
    expect(text).toContain("does not match ^[0-9]{2,5}$");
    expect(hostile.sampled).toHaveLength(0);
  });
});

describe("credential kinds and parameters", () => {
  const withBasicTool = (kind: string) => (stepfile: JsonObject, addresses: { catalogue: string }) => {
    const catalogue = (stepfile.tools as JsonObject).catalogue as JsonObject;
    (stepfile.tools as JsonObject)["catalogue-basic"] = { openapi: catalogue.openapi as JsonObject, credential: "catalogue-basic", exposes: ["getBasicItem"] };
    (stepfile.credentials as JsonObject)["catalogue-basic"] = { kind, hosts: [new URL(addresses.catalogue).host], description: "Reads the catalogue with HTTP Basic." };
    (steps(stepfile)[0] as JsonObject).tools = ["getBasicItem"];
  };

  it("sends a basic credential as HTTP Basic", async () => {
    const { call, api, records } = await start({
      edit: withBasicTool("basic"),
      credentials: { catalogue: API_KEY, suppliers: MCP_TOKEN, "catalogue-basic": BASIC_CREDENTIAL },
      turns: [use("b1", "getBasicItem", { id: "K-1" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(api.received.find((request) => request.path === "/basic-items/K-1")?.headers.authorization).toBe(`Basic ${Buffer.from(BASIC_CREDENTIAL).toString("base64")}`);
    expect(records.find((record) => record.type === "tool_call")).toMatchObject({ operation: "getBasicItem", status: 200 });
  });

  it("refuses a basic credential that is not user:secret", async () => {
    const { call } = await start({ edit: withBasicTool("basic"), credentials: { catalogue: API_KEY, suppliers: MCP_TOKEN, "catalogue-basic": "just-a-token" }, turns: [] });

    expect(resultText(await call({ item: "K-1" }))).toContain("PreflightFailed: preflight failed for credential catalogue-basic: a basic credential must be user:secret");
  });

  it("sends a parameter with one allowed value itself and hides it from the model", async () => {
    const { call, api, sampled } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "getFormattedItem"];
        (steps(stepfile)[0] as JsonObject).tools = ["getFormattedItem"];
      },
      turns: [use("f1", "getFormattedItem", { id: "K-1" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(api.received.map((request) => request.path)).toContain("/formatted/K-1?format=json");
    const tool = sampled[0]?.tools?.find((item) => item.name === "getFormattedItem");
    expect(Object.keys((tool?.inputSchema as { properties: JsonObject }).properties)).toEqual(["id"]);
  });

  it("sends an array query parameter as repeated names, or comma-separated when explode is false", async () => {
    const { call, api } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "searchItems"];
        (steps(stepfile)[0] as JsonObject).tools = ["searchItems"];
      },
      turns: [use("s0", "searchItems", { tag: ["red", "blue"], fields: ["name", "stock"] }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(api.received.map((request) => request.path)).toContain("/search?tag=red&tag=blue&fields=name%2Cstock");
  });

  it("sends a message/rfc822 body as the raw text the model wrote", async () => {
    const email = "To: ops@example.com\r\nSubject: Stock check\r\n\r\nBlue kettle has 4 in stock.";
    const { call, api, sampled } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "createDraft"];
        (steps(stepfile)[0] as JsonObject).tools = ["createDraft"];
      },
      turns: [use("d1", "createDraft", { body: email }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    const draft = api.received.find((request) => request.path === "/drafts");
    expect(draft?.headers["content-type"]).toBe("message/rfc822");
    expect(draft?.body).toBe(email);
    const tool = sampled[0]?.tools?.find((item) => item.name === "createDraft");
    expect((tool?.inputSchema as unknown as { properties: { body: JsonObject } }).properties.body).toEqual({ type: "string" });
  });

  it("compares strings case-insensitively with lower", async () => {
    const { call } = await start({
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).gates = [{
        id: "supplier-is-acme",
        message: "supplier must be Acme",
        predicate: { "==": [{ lower: { var: "output.supplier" } }, { lower: "ACME" }] },
      }]),
      turns: [GOOD_STOCK, GOOD_SUMMARY],
    });

    expect((await call({ item: "K-1" })).isError).toBeFalsy();
  });
});

describe("control flow", () => {
  it("skips a step whose when predicate is not true, without asking the model", async () => {
    const { call, sampled, records } = await start({
      edit: (stepfile) => void ((steps(stepfile)[1] as JsonObject).when = { ">": [{ var: "steps.stock.count" }, 10] }),
      turns: [GOOD_STOCK],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(Object.keys((result.structuredContent as { outputs: JsonObject }).outputs)).toEqual(["stock"]);
    expect(sampled).toHaveLength(1);
    expect(records.some((record) => record.type === "step_skipped" && record.step === "summary")).toBe(true);
  });

  it("stops a step that never submits at the turn limit", async () => {
    const lookup = (id: string) => use(id, "lookup", { query: "Acme" });
    const { call, sampled } = await start({ limits: { turnsPerStep: 3, toolResultChars: 10_000 }, turns: [lookup("l1"), lookup("l2"), lookup("l3")] });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^TurnLimitReached: step stock/);
    expect(sampled).toHaveLength(3);
  });
});

describe("tool calls", () => {
  it("refuses a tool the step does not allow, records it, and makes no request", async () => {
    const { call, sampled, records, api } = await start({ turns: [use("r1", "getRevoked", {}), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(sampled[1]?.messages.at(-1)).toMatchObject({
      content: [{ type: "tool_result", toolUseId: "r1", isError: true, content: [{ type: "text", text: "getRevoked is not available in this step." }] }],
    });
    expect(records).toContainEqual(expect.objectContaining({ type: "tool_refused", step: "stock", operation: "getRevoked" }));
    expect(api.received.map((request) => request.path)).not.toContain("/revoked");
  });

  it("answers arguments that break the tool's schema with an error and makes no request", async () => {
    const { call, sampled, api } = await start({ turns: [use("i1", "getItem", { id: 7 }), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(sampled[1]?.messages.at(-1)).toMatchObject({ content: [{ type: "tool_result", toolUseId: "i1", isError: true }] });
    expect(api.received.filter((request) => request.path.startsWith("/items"))).toEqual([]);
  });

  it("percent-encodes a hostile path parameter so it stays on the declared host and path", async () => {
    const { call, api } = await start({ turns: [use("h1", "getItem", { id: "../../x@evil.example/steal" }), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(api.received.map((request) => request.path)).toContain("/items/..%2F..%2Fx%40evil.example%2Fsteal");
  });

  it("identifies itself to APIs with a stepgate user agent", async () => {
    const { call, api, mcp } = await start({ turns: STOCK_WITH_TOOLS });

    await call({ item: "K-1" });

    const agents = [...api.received, ...mcp.received].map((request) => request.headers["user-agent"]);
    expect(agents.length).toBeGreaterThan(0);
    expect(new Set(agents)).toEqual(new Set([`stepgate/${VERSION} (+https://github.com/Chaarangan/stepgate)`]));
  });

  it("cuts a tool result to the limit, marks the cut for the model, and records the original length", async () => {
    const { call, sampled, records } = await start({ limits: { turnsPerStep: 8, toolResultChars: 12 }, turns: STOCK_WITH_TOOLS });

    await call({ item: "K-1" });

    const [itemResult] = (sampled[1]?.messages.at(-1)?.content ?? []) as Array<{ content: Array<{ text: string }> }>;
    expect(itemResult?.content[0]?.text).toMatch(/^\{"id":"K-1",\n\[truncated: the result was \d+ characters; only the first 12 are shown\]$/);
    const getItem = records.find((record) => record.type === "tool_call" && record.operation === "getItem");
    expect(getItem).toMatchObject({ truncated_to: 12 });
    expect((getItem?.response as { length: number }).length).toBeGreaterThan(12);
  });
});

describe("external call failures", () => {
  it("retries a busy API with a ledger record per retry, then succeeds", async () => {
    const { call, records } = await start({
      flakyFailures: 2,
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).tools = ["getFlaky"]),
      turns: [use("f1", "getFlaky", {}), GOOD_STOCK, GOOD_SUMMARY],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(records.filter((record) => record.type === "retry").map((record) => [record.attempt, record.status])).toEqual([[1, 503], [2, 503]]);
    expect(records.find((record) => record.type === "tool_call")).toMatchObject({ operation: "getFlaky", status: 200 });
  });

  const exposing = (operation: string) => (stepfile: JsonObject) => {
    ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", operation];
    (steps(stepfile)[0] as JsonObject).tools = [operation];
  };

  it("waits as long as Retry-After asks before retrying", async () => {
    const { call, records } = await start({ edit: exposing("getLimited"), turns: [use("r1", "getLimited", {}), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    const retry = records.find((record) => record.type === "retry");
    expect(retry).toMatchObject({ attempt: 1, status: 429, wait_ms: 1000 });
    expect(records.find((record) => record.type === "tool_call")).toMatchObject({ operation: "getLimited", status: 200 });
  });

  it("treats a 403 with GitHub rate-limit headers as a rate limit, not a refusal", async () => {
    const { call, records } = await start({ edit: exposing("getSecondaryLimited"), turns: [use("r2", "getSecondaryLimited", {}), GOOD_STOCK, GOOD_SUMMARY] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(records.find((record) => record.type === "retry")).toMatchObject({ status: 403 });
    expect(Number(records.find((record) => record.type === "retry")?.wait_ms)).toBeLessThanOrEqual(2000);
  });

  it("stops at once when an API asks for a longer wait than Stepgate allows", async () => {
    const { call, api } = await start({ edit: exposing("getLongLimited"), turns: [use("r3", "getLongLimited", {})] });

    const text = resultText(await call({ item: "K-1" }));

    expect(text).toContain("ToolCallFailed");
    expect(text).toContain("asked to wait 120s, more than the 60s Stepgate allows");
    expect(api.received.filter((request) => request.path === "/limited-long")).toHaveLength(1);
  });

  it("raises InvalidGrant on the first invalid_grant response, without retrying", async () => {
    const { call, records, api } = await start({
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).tools = ["getRevoked"]),
      turns: [use("g1", "getRevoked", {})],
    });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^InvalidGrant: /);
    expect(api.received.filter((request) => request.path === "/revoked")).toHaveLength(1);
    expect(records.some((record) => record.type === "retry")).toBe(false);
  });
});

describe("preflight", () => {
  const cases: Array<{ name: string; setup: Omit<Setup, "turns">; inputs: JsonObject; item: string }> = [
    {
      name: "an MCP tool the server does not offer",
      setup: { edit: (stepfile) => void (((stepfile.tools as JsonObject).suppliers as JsonObject).exposes = ["lookup", "delete-everything"]) },
      inputs: { item: "K-1" },
      item: "tool suppliers",
    },
    {
      name: "a credential missing from the environment",
      setup: { credentials: { catalogue: API_KEY } },
      inputs: { item: "K-1" },
      item: "credential suppliers",
    },
    {
      name: "an OpenAPI document whose bytes do not match its digest",
      setup: { edit: (stepfile) => void ((((stepfile.tools as JsonObject).catalogue as JsonObject).openapi as JsonObject).sha256 = `sha256:${"0".repeat(64)}`) },
      inputs: { item: "K-1" },
      item: "tool catalogue",
    },
    {
      name: "inputs that break the stepfile's input schema",
      setup: {},
      inputs: { item: 3 },
      item: "inputs",
    },
  ];

  it.each(cases)("fails before any model turn on $name", async ({ setup, inputs, item }) => {
    const { call, sampled, records } = await start({ ...setup, turns: [] });

    const result = await call(inputs);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`PreflightFailed: preflight failed for ${item}`);
    expect(sampled).toHaveLength(0);
    expect(records.map((record) => record.type)).toEqual(["run_started", "run_failed"]);
  });
});
