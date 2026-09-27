import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/engine/types.ts";
import { environmentCredentials } from "../src/operator.ts";
import { userAgent, VERSION } from "../src/version.ts";
import { API_KEY, BASIC_CREDENTIAL, MCP_TOKEN } from "./fixtures.ts";
import { GOOD_STOCK, GOOD_SUMMARY, resultText, startHarness, stateOf, stepViews, submit, use, type Harness, type Setup } from "./harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(setup: Setup): Promise<Harness> {
  harness = await startHarness(setup);
  return harness;
}

const STOCK_WITH_TOOLS = [use("getItem", { id: "K-1" }), use("lookup", { query: "Acme" }), GOOD_STOCK, GOOD_SUMMARY];

function steps(stepfile: JsonObject): JsonObject[] {
  return stepfile.steps as JsonObject[];
}

function textOf(result: CallToolResult | undefined): string {
  return result === undefined ? "" : resultText(result);
}

const badCount = submit({ name: "Blue kettle", count: 0, supplier: "Acme" });

describe("secrecy and isolation", () => {
  it("never shows the client a credential, and keeps credentials out of the ledger", async () => {
    const { call, seen, records } = await start({ actions: STOCK_WITH_TOOLS });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    for (const secret of [API_KEY, MCP_TOKEN]) {
      expect(JSON.stringify(seen)).not.toContain(secret);
      expect(JSON.stringify(records)).not.toContain(secret);
    }
  });

  it("shows each step only its own instructions and operations", async () => {
    const { call, seen } = await start({ actions: STOCK_WITH_TOOLS });

    await call({ item: "K-1" });

    const summary = stepViews(seen)[1];
    expect(summary?.instructions).toBe("Summarise: Blue kettle has 4 in stock.");
    expect(summary?.operations).toEqual([]);
    expect(JSON.stringify(seen.slice(0, 1))).not.toContain("Summarise");
    expect(JSON.stringify(seen.at(-2))).not.toContain("Find item");
  });
});

describe("gates", () => {
  it("sends a failed gate's diagnosis back to the client and accepts the corrected submission", async () => {
    const { call, seen, records } = await start({ actions: [badCount, GOOD_STOCK, GOOD_SUMMARY] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(seen[1]?.isError).toBe(true);
    expect(stateOf(seen[1])).toMatchObject({ state: "running", attempts_left: 1 });
    expect(textOf(seen[1])).toMatch(/count-positive[\s\S]*count must be positive/);
    const verdicts = records.filter((record) => record.type === "gate" && record.step === "stock").map((record) => [record.attempt, record.verdict]);
    expect(verdicts).toEqual([[1, "fail"], [2, "pass"]]);
  });

  it("rejects an output that breaks the step's produces schema as the produces gate", async () => {
    const { call, seen, records } = await start({ actions: [submit({ name: "Blue kettle" }), GOOD_STOCK, GOOD_SUMMARY] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(textOf(seen[1])).toMatch(/- produces: /);
    expect(records).toContainEqual(expect.objectContaining({ type: "gate", step: "stock", attempt: 1, gate: "produces", verdict: "fail" }));
  });

  it("halts with GateFailed naming the gate once the step's retries are used up", async () => {
    const { call, records } = await start({ actions: [badCount, badCount] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBe(true);
    expect(stateOf(result)).toMatchObject({ state: "failed", error: "GateFailed" });
    expect(resultText(result)).toMatch(/^GateFailed: step stock failed gates: count-positive/);
    expect(records.at(-1)).toMatchObject({ type: "run_failed", error: "GateFailed" });
  });

  it("asks an http verifier and feeds its failing verdict back to the client", async () => {
    const { call, seen, api } = await start({
      edit: (stepfile, addresses) => {
        (stepfile.tools as JsonObject).checker = { verifier: { url: addresses.checker } };
        (steps(stepfile)[0] as JsonObject).gates = [{ id: "enough", http: { tool: "checker" } }];
      },
      actions: [submit({ name: "Blue kettle", count: 2, supplier: "Acme" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(textOf(seen[1])).toMatch(/enough[\s\S]*count 2 is below 3/);
    const verifications = api.received.filter((request) => request.path === "/verify").map((request) => JSON.parse(request.body) as JsonObject);
    expect(verifications).toHaveLength(2);
    expect(verifications[0]).toMatchObject({ stepfile: "stock-check", step: "stock", gate: "enough", inputs: { item: "K-1" }, output: { count: 2 } });
  });
});

describe("approve gates", () => {
  const approving = (stepfile: JsonObject) => {
    const summary = steps(stepfile)[1] as JsonObject;
    summary.gates = [{ id: "reviewed", approve: { message: "Send this summary to the customer?" } }];
    summary.retries = 1;
  };

  it("asks a person through elicitation and continues when they approve", async () => {
    const { call, asked, records } = await start({ edit: approving, approvals: [{ action: "accept" }], actions: [GOOD_STOCK, GOOD_SUMMARY] });

    const result = await call({ item: "K-1" });

    expect(stateOf(result)).toMatchObject({ state: "finished" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Send this summary to the customer\?\n\nStep summary of stock-check submitted:\n[\s\S]*Blue kettle has 4 in stock/);
    expect(records).toContainEqual(expect.objectContaining({ type: "gate", gate: "reviewed", verdict: "pass" }));
  });

  it("returns a person's reason for declining to the client as the gate's diagnosis", async () => {
    const { call, seen } = await start({
      edit: approving,
      approvals: [{ action: "decline", reason: "Mention the supplier." }, { action: "accept" }],
      actions: [GOOD_STOCK, GOOD_SUMMARY, submit({ summary: "Blue kettle has 4 in stock, from Acme." })],
    });

    const result = await call({ item: "K-1" });

    expect(textOf(seen[2])).toContain("- reviewed: a person declined to approve this output: Mention the supplier.");
    expect(stateOf(result)).toMatchObject({ state: "finished", outputs: { summary: { summary: "Blue kettle has 4 in stock, from Acme." } } });
  });

  it("fails preflight when the client cannot ask a person", async () => {
    const { call, seen } = await start({ edit: approving, actions: [] });

    expect(resultText(await call({ item: "K-1" }))).toContain("PreflightFailed: preflight failed for approval: the stepfile has approve gates");
    expect(stepViews(seen)).toEqual([]);
  });
});

describe("verifier outages", () => {
  it("stops the run with ToolCallFailed when a verifier answers with something other than JSON", async () => {
    const { call, records } = await start({
      edit: (stepfile, addresses) => {
        (stepfile.tools as JsonObject).checker = { verifier: { url: `${addresses.catalogue}/verify-garbage` } };
        (steps(stepfile)[0] as JsonObject).gates = [{ id: "enough", http: { tool: "checker" } }];
      },
      actions: [GOOD_STOCK],
    });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^ToolCallFailed: verifier checker failed with status 200: response is not JSON: <html>maintenance/);
    expect(records.at(-1)).toMatchObject({ type: "run_failed", error: "ToolCallFailed" });
  });
});

describe("evidence", () => {
  const countMatchesCatalogue = (stepfile: JsonObject) => {
    (steps(stepfile)[0] as JsonObject).gates = [{
      id: "count-from-catalogue",
      message: "count must be the stock level the catalogue returned",
      predicate: { in: [{ var: "output.count" }, { map: [{ filter: [{ var: "calls" }, { "==": [{ var: "tool" }, "getItem"] }] }, { var: "result.stock" }] }] },
    }];
  };

  it("rejects a value no tool returned, and accepts the one the API gave", async () => {
    const { call, seen } = await start({
      edit: countMatchesCatalogue,
      actions: [use("getItem", { id: "K-1" }), submit({ name: "Blue kettle", count: 5, supplier: "Acme" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(textOf(seen[2])).toContain("count must be the stock level the catalogue returned");
  });

  it("adds what explain evaluates to after a failed gate's message, naming what broke the rule", async () => {
    const found = { match_all: [{ reduce: [{ var: "calls" }, { cat: [{ var: "accumulator" }, { var: "current.result" }, "\n"] }, ""] }, "Supplier ([A-Za-z]+):"] };
    const { call, seen } = await start({
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).gates = [{
        id: "suppliers-from-lookup",
        message: "every supplier must be one the lookup returned; these were not:",
        predicate: { subset: [{ var: "output.suppliers" }, found] },
        explain: { difference: [{ var: "output.suppliers" }, found] },
      }]),
      actions: [use("lookup", { query: "Acme" }), submit({ name: "Blue kettle", count: 4, supplier: "Acme", suppliers: ["Acme", "Globex", "Initech"] })],
    });

    await call({ item: "K-1" });

    expect(textOf(seen[2])).toContain('- suppliers-from-lookup: every supplier must be one the lookup returned; these were not: ["Globex","Initech"]');
  });

  it("shows the client only what select keeps, while gates still check the whole result", async () => {
    const { call, seen, records } = await start({
      edit: (stepfile) => {
        countMatchesCatalogue(stepfile);
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = [{ name: "getItem", select: { cat: ["stock: ", { var: "stock" }] } }, "getFlaky", "getRevoked"];
      },
      actions: [use("getItem", { id: "K-1" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    const result = await call({ item: "K-1" });

    expect(textOf(seen[1])).toBe('"stock: 4"');
    expect(result.isError).toBeFalsy();
    expect(records.find((record) => record.type === "tool_call")).toMatchObject({ shown: { length: 10, selected: true } });
  });

  it("cannot pass an evidence gate without calling the tool", async () => {
    const { call } = await start({ edit: countMatchesCatalogue, actions: [GOOD_STOCK, GOOD_STOCK] });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^GateFailed: step stock failed gates: count-from-catalogue/);
  });

  it("gives gates a text result as text", async () => {
    const { call } = await start({
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).gates = [{
        id: "city-from-lookup",
        message: "supplier city must come from the lookup",
        predicate: { in: ["Leeds", { reduce: [{ var: "calls" }, { cat: [{ var: "accumulator" }, { var: "current.result" }] }, ""] }] },
      }]),
      actions: STOCK_WITH_TOOLS,
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
    const { call, api } = await start({ edit: catalogueFromSetting, settings: ({ cataloguePort }) => ({ "catalogue-port": cataloguePort }), actions: STOCK_WITH_TOOLS });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(api.received.find((request) => request.path === "/items/K-1")?.headers["x-api-key"]).toBe(API_KEY);
  });

  it("fails preflight when a setting is missing, or its value could change the host", async () => {
    const missing = await start({ edit: catalogueFromSetting, actions: [] });
    expect(resultText(await missing.call({ item: "K-1" }))).toContain("PreflightFailed: preflight failed for setting catalogue-port");
    await missing.close();
    harness = undefined;

    const hostile = await start({ edit: catalogueFromSetting, settings: () => ({ "catalogue-port": "80@evil.example" }), actions: [] });
    const text = resultText(await hostile.call({ item: "K-1" }));
    expect(text).toContain("PreflightFailed: preflight failed for setting catalogue-port");
    expect(text).toContain("does not match ^[0-9]{2,5}$");
    expect(hostile.api.received).toEqual([]);
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
      actions: [use("getBasicItem", { id: "K-1" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(api.received.find((request) => request.path === "/basic-items/K-1")?.headers.authorization).toBe(`Basic ${Buffer.from(BASIC_CREDENTIAL).toString("base64")}`);
    expect(records.find((record) => record.type === "tool_call")).toMatchObject({ operation: "getBasicItem", status: 200 });
  });

  it("refuses a basic credential that is not user:secret", async () => {
    const { call } = await start({ edit: withBasicTool("basic"), credentials: { catalogue: API_KEY, suppliers: MCP_TOKEN, "catalogue-basic": "just-a-token" }, actions: [] });

    expect(resultText(await call({ item: "K-1" }))).toContain("PreflightFailed: preflight failed for credential catalogue-basic: a basic credential must be user:secret");
  });

  it("sends a parameter with one allowed value itself and hides it from the client", async () => {
    const { call, api, seen } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "getFormattedItem"];
        (steps(stepfile)[0] as JsonObject).tools = ["getFormattedItem"];
      },
      actions: [use("getFormattedItem", { id: "K-1" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(api.received.map((request) => request.path)).toContain("/formatted/K-1?format=json");
    const operation = stepViews(seen)[0]?.operations.find((item) => item.name === "getFormattedItem");
    expect(Object.keys((operation?.inputSchema as { properties: JsonObject }).properties)).toEqual(["id"]);
  });

  it("sends an array query parameter as repeated names, or comma-separated when explode is false", async () => {
    const { call, api } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "searchItems"];
        (steps(stepfile)[0] as JsonObject).tools = ["searchItems"];
      },
      actions: [use("searchItems", { tag: ["red", "blue"], fields: ["name", "stock"] }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(api.received.map((request) => request.path)).toContain("/search?tag=red&tag=blue&fields=name%2Cstock");
  });

  it("sends a message/rfc822 body as the raw text the client wrote", async () => {
    const email = "To: ops@example.com\r\nSubject: Stock check\r\n\r\nBlue kettle has 4 in stock.";
    const { call, api, seen } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "createDraft"];
        (steps(stepfile)[0] as JsonObject).tools = ["createDraft"];
      },
      actions: [use("createDraft", { body: email }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    const draft = api.received.find((request) => request.path === "/drafts");
    expect(draft?.headers["content-type"]).toBe("message/rfc822");
    expect(draft?.body).toBe(email);
    const operation = stepViews(seen)[0]?.operations.find((item) => item.name === "createDraft");
    expect((operation?.inputSchema as unknown as { properties: { body: JsonObject } }).properties.body).toEqual({ type: "string" });
  });

  it("compares strings case-insensitively with lower", async () => {
    const { call } = await start({
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).gates = [{
        id: "supplier-is-acme",
        message: "supplier must be Acme",
        predicate: { "==": [{ lower: { var: "output.supplier" } }, { lower: "ACME" }] },
      }]),
      actions: [GOOD_STOCK, GOOD_SUMMARY],
    });

    expect((await call({ item: "K-1" })).isError).toBeFalsy();
  });
});

describe("oauth2 refresh", () => {
  const withOAuthTool = (stepfile: JsonObject, addresses: { catalogue: string }) => {
    const catalogue = (stepfile.tools as JsonObject).catalogue as JsonObject;
    (stepfile.tools as JsonObject)["catalogue-oauth"] = { openapi: catalogue.openapi as JsonObject, credential: "catalogue-oauth", exposes: ["getOAuthItem", "getStrictOAuthItem"] };
    (stepfile.credentials as JsonObject)["catalogue-oauth"] = {
      kind: "oauth2",
      scopes: ["read:items"],
      token_url: `${addresses.catalogue}/token`,
      hosts: [new URL(addresses.catalogue).host],
      description: "Reads the catalogue with OAuth.",
    };
    (steps(stepfile)[0] as JsonObject).tools = ["getOAuthItem", "getStrictOAuthItem"];
  };
  const operatorEnvironment = (refreshToken: string) => environmentCredentials({
    CATALOGUE_API_KEY: API_KEY,
    SUPPLIERS_API_KEY: MCP_TOKEN,
    CATALOGUE_OAUTH_REFRESH_TOKEN: refreshToken,
    CATALOGUE_OAUTH_CLIENT_ID: "stepgate-tests",
  }, { userAgent: userAgent(null), limits: { requestTimeoutMs: 5_000, responseBytes: 1_000_000 } });
  const tokenRequests = (api: Harness["api"]) => api.received.filter((request) => request.path === "/token").map((request) => new URLSearchParams(request.body));

  it("exchanges the refresh token at token_url with the scopes, and reuses the access token until it expires", async () => {
    const { call, api } = await start({
      edit: withOAuthTool,
      credentialSource: operatorEnvironment("refresh-1"),
      actions: [use("getOAuthItem", { id: "K-1" }), use("getOAuthItem", { id: "K-2" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    const exchanges = tokenRequests(api);
    expect(exchanges).toHaveLength(1);
    expect(Object.fromEntries(exchanges[0] ?? [])).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "stepgate-tests", scope: "read:items" });
    const authorizations = api.received.filter((request) => request.path.startsWith("/oauth-items/")).map((request) => request.headers.authorization);
    expect(authorizations).toEqual(["Bearer fresh-1", "Bearer fresh-1"]);
  });

  it("refreshes with the rotated refresh token and resends once when an API rejects the access token", async () => {
    const { call, api, seen } = await start({
      edit: withOAuthTool,
      credentialSource: operatorEnvironment("refresh-1"),
      actions: [use("getStrictOAuthItem", { id: "K-1" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    await call({ item: "K-1" });

    expect(textOf(seen[1])).toContain('"stock":4');
    expect(tokenRequests(api).map((form) => form.get("refresh_token"))).toEqual(["refresh-1", "rotated-1"]);
  });

  it("fails preflight with the provider's answer when the refresh token was revoked", async () => {
    const { call } = await start({ edit: withOAuthTool, credentialSource: operatorEnvironment("revoked"), actions: [] });

    const text = resultText(await call({ item: "K-1" }));

    expect(text).toContain("PreflightFailed: preflight failed for credential catalogue-oauth: credential catalogue-oauth has an invalid grant");
  });
});

describe("control flow", () => {
  it("skips a step whose when predicate is not true, without showing it to the client", async () => {
    const { call, seen, records } = await start({
      edit: (stepfile) => void ((steps(stepfile)[1] as JsonObject).when = { ">": [{ var: "steps.stock.count" }, 10] }),
      actions: [GOOD_STOCK],
    });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(Object.keys(stateOf(result).outputs as JsonObject)).toEqual(["stock"]);
    expect(stepViews(seen).map((view) => view.step)).toEqual(["stock"]);
    expect(records.some((record) => record.type === "step_skipped" && record.step === "summary")).toBe(true);
  });

  it("stops a step that keeps calling at the call limit", async () => {
    const lookup = use("lookup", { query: "Acme" });
    const { call, records } = await start({ limits: { callsPerStep: 3, toolResultChars: 10_000 }, actions: [lookup, lookup, lookup, lookup] });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^CallLimitReached: step stock/);
    expect(records.filter((record) => record.type === "tool_call")).toHaveLength(3);
  });
});

describe("tool calls", () => {
  it("refuses an operation the step does not allow, records it, and makes no request", async () => {
    const { call, seen, records, api } = await start({ actions: [use("getRevoked", {}), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(seen[1]).toMatchObject({ isError: true, content: [{ type: "text", text: "getRevoked is not available in this step." }] });
    expect(records).toContainEqual(expect.objectContaining({ type: "tool_refused", step: "stock", operation: "getRevoked" }));
    expect(api.received.map((request) => request.path)).not.toContain("/revoked");
  });

  it("answers arguments that break the operation's schema with an error and makes no request", async () => {
    const { call, seen, api } = await start({ actions: [use("getItem", { id: 7 }), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(seen[1]?.isError).toBe(true);
    expect(textOf(seen[1])).toMatch(/^Invalid arguments for getItem/);
    expect(api.received.filter((request) => request.path.startsWith("/items"))).toEqual([]);
  });

  it("percent-encodes a hostile path parameter so it stays on the declared host and path", async () => {
    const { call, api } = await start({ actions: [use("getItem", { id: "../../x@evil.example/steal" }), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(api.received.map((request) => request.path)).toContain("/items/..%2F..%2Fx%40evil.example%2Fsteal");
  });

  it("identifies itself to APIs with a stepgate user agent", async () => {
    const { call, api, mcp } = await start({ actions: STOCK_WITH_TOOLS });

    await call({ item: "K-1" });

    const agents = [...api.received, ...mcp.received].map((request) => request.headers["user-agent"]);
    expect(agents.length).toBeGreaterThan(0);
    expect(new Set(agents)).toEqual(new Set([`stepgate/${VERSION} (+https://github.com/Chaarangan/stepgate)`]));
  });

  it("cuts a tool result to the limit, marks the cut for the client, and records the original length", async () => {
    const { call, seen, records } = await start({ limits: { callsPerStep: 8, toolResultChars: 12 }, actions: STOCK_WITH_TOOLS });

    await call({ item: "K-1" });

    expect(textOf(seen[1])).toMatch(/^\{"id":"K-1",\n\[truncated: the result was \d+ characters; only the first 12 are shown\]$/);
    const getItem = records.find((record) => record.type === "tool_call" && record.operation === "getItem");
    expect(getItem).toMatchObject({ truncated_to: 12 });
    expect((getItem?.response as { length: number }).length).toBeGreaterThan(12);
  });
});

describe("egress limits", () => {
  const exposing = (operation: string) => (stepfile: JsonObject) => {
    ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", operation];
    (steps(stepfile)[0] as JsonObject).tools = [operation];
  };

  it("refuses a redirect to a host no tool declares, and never sends it the credential", async () => {
    const { call, api } = await start({ edit: exposing("getRedirectAway"), actions: [use("getRedirectAway", {})] });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^EgressDenied: egress denied: catalogue\.getRedirectAway targeted undeclared host localhost:\d+/);
    expect(api.received.filter((request) => request.path === "/items/K-1")).toEqual([]);
  });

  it("follows a redirect on the declared host and sends the credential again", async () => {
    const { call, api, seen } = await start({ edit: exposing("getRedirectHome"), actions: [use("getRedirectHome", {}), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(textOf(seen[1])).toContain('"stock":4');
    expect(api.received.find((request) => request.path === "/items/K-1")?.headers["x-api-key"]).toBe(API_KEY);
  });

  it("does not retry a POST after a 5xx, since it may already have taken effect", async () => {
    const { call, api, records, seen } = await start({ edit: exposing("postBusy"), actions: [use("postBusy", {}), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    expect(textOf(seen[1])).toMatch(/^HTTP 503: /);
    expect(api.received.filter((request) => request.path === "/busy")).toHaveLength(1);
    expect(records.some((record) => record.type === "retry")).toBe(false);
  });

  it("ends a request that outlasts the deadline with ToolCallFailed", async () => {
    const { call } = await start({ limits: { requestTimeoutMs: 100 }, edit: exposing("postSlow"), actions: [use("postSlow", {})] });

    const text = resultText(await call({ item: "K-1" }));

    expect(text).toMatch(/^ToolCallFailed: catalogue\.postSlow failed with status none: no response before the request deadline; not retried/);
  });

  it("stops reading a response larger than the limit with ResponseTooLarge", async () => {
    const { call, records } = await start({ limits: { responseBytes: 1_000 }, edit: exposing("getHuge"), actions: [use("getHuge", {})] });

    const text = resultText(await call({ item: "K-1" }));

    expect(text).toMatch(/^ResponseTooLarge: catalogue\.getHuge returned more than the 1000 bytes Stepgate reads/);
    expect(records.at(-1)).toMatchObject({ type: "run_failed", error: "ResponseTooLarge" });
  });
});

describe("external call failures", () => {
  it("retries a busy API with a ledger record per retry, then succeeds", async () => {
    const { call, records } = await start({
      flakyFailures: 2,
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).tools = ["getFlaky"]),
      actions: [use("getFlaky", {}), GOOD_STOCK, GOOD_SUMMARY],
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
    const { call, records } = await start({ edit: exposing("getLimited"), actions: [use("getLimited", {}), GOOD_STOCK, GOOD_SUMMARY] });

    await call({ item: "K-1" });

    const retry = records.find((record) => record.type === "retry");
    expect(retry).toMatchObject({ attempt: 1, status: 429, wait_ms: 1000 });
    expect(records.find((record) => record.type === "tool_call")).toMatchObject({ operation: "getLimited", status: 200 });
  });

  it("treats a 403 with GitHub rate-limit headers as a rate limit, not a refusal", async () => {
    const { call, records } = await start({ edit: exposing("getSecondaryLimited"), actions: [use("getSecondaryLimited", {}), GOOD_STOCK, GOOD_SUMMARY] });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(records.find((record) => record.type === "retry")).toMatchObject({ status: 403 });
    expect(Number(records.find((record) => record.type === "retry")?.wait_ms)).toBeLessThanOrEqual(2000);
  });

  it("stops at once when an API asks for a longer wait than Stepgate allows", async () => {
    const { call, api } = await start({ edit: exposing("getLongLimited"), actions: [use("getLongLimited", {})] });

    const text = resultText(await call({ item: "K-1" }));

    expect(text).toContain("ToolCallFailed");
    expect(text).toContain("asked to wait 120s, more than the 60s Stepgate allows");
    expect(api.received.filter((request) => request.path === "/limited-long")).toHaveLength(1);
  });

  it("raises InvalidGrant on the first invalid_grant response, without retrying", async () => {
    const { call, records, api } = await start({
      edit: (stepfile) => void ((steps(stepfile)[0] as JsonObject).tools = ["getRevoked"]),
      actions: [use("getRevoked", {})],
    });

    const result = await call({ item: "K-1" });

    expect(resultText(result)).toMatch(/^InvalidGrant: /);
    expect(api.received.filter((request) => request.path === "/revoked")).toHaveLength(1);
    expect(records.some((record) => record.type === "retry")).toBe(false);
  });
});

describe("preflight", () => {
  const cases: Array<{ name: string; setup: Omit<Setup, "actions">; inputs: JsonObject; item: string }> = [
    {
      name: "an MCP tool the server does not offer",
      setup: { edit: (stepfile) => void (((stepfile.tools as JsonObject).suppliers as JsonObject).exposes = ["lookup", "delete-everything"]) },
      inputs: { item: "K-1" },
      item: "tool suppliers",
    },
    {
      name: "an MCP tool whose input schema no longer matches its pin",
      setup: { edit: (stepfile) => void (((stepfile.tools as JsonObject).suppliers as JsonObject).exposes = [{ name: "lookup", schema_sha256: `sha256:${"0".repeat(64)}` }]) },
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

  it.each(cases)("fails before showing any step on $name", async ({ setup, inputs, item }) => {
    const { call, seen, records } = await start({ ...setup, actions: [] });

    const result = await call(inputs);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`PreflightFailed: preflight failed for ${item}`);
    expect(stepViews(seen)).toEqual([]);
    expect(records.map((record) => record.type)).toEqual(["run_started", "run_failed"]);
  });
});
