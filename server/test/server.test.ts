import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/engine/types.ts";
import { GOOD_STOCK, GOOD_SUMMARY, resultText, startHarness, stateOf, stepViews, use, type Harness, type Setup } from "./harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(setup: Setup): Promise<Harness> {
  harness = await startHarness(setup);
  return harness;
}

const ACTIONS = [use("getItem", { id: "K-1" }), use("lookup", { query: "Acme" }), GOOD_STOCK, GOOD_SUMMARY];

describe("Stepgate MCP server", () => {
  it("lists each stepfile as a tool with the stepfile's input schema, beside the run and authoring tools", async () => {
    const { client } = await start({ actions: [] });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "stock-check", "stepgate_call", "stepgate_submit",
      "stepgate_guide", "stepgate_examples", "stepgate_validate", "stepgate_inspect_api", "stepgate_try",
    ]);
    expect(tools[0]).toMatchObject({ description: expect.stringContaining("Checks an item's stock and its supplier."), inputSchema: { required: ["item"] } });
    expect(client.getInstructions()).toContain("stepgate_submit");
  });

  it("runs a stepfile the client drives step by step and returns every step's output", async () => {
    const { call, seen } = await start({ actions: ACTIONS });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBeFalsy();
    expect(stateOf(result)).toMatchObject({
      state: "finished",
      outputs: { stock: { name: "Blue kettle", count: 4, supplier: "Acme" }, summary: { summary: "Blue kettle has 4 in stock." } },
    });
    expect(resultText(seen[0] as CallToolResult)).toMatch(/^Run [0-9a-f-]+, step 1 of 2: stock\.[\s\S]*Find item K-1[\s\S]*stepgate_submit/);
    expect(stepViews(seen)[0]?.operations.map((operation) => operation.name)).toEqual(["getItem", "lookup"]);
    expect(seen[2]).toMatchObject({ isError: false, content: [{ type: "text", text: "Supplier Acme: based in Leeds" }] });
    // Claude Code shows structuredContent in place of the text, so the result must be there too.
    expect(stateOf(seen[2])).toMatchObject({ state: "running", result: "Supplier Acme: based in Leeds" });
  });

  it("answers a call for a run that is not active with RunNotActive, and contacts nothing", async () => {
    const { client, call, api, seen } = await start({ actions: [GOOD_STOCK, GOOD_SUMMARY] });

    const unknown = await client.callTool({ name: "stepgate_call", arguments: { run: "no-such-run", operation: "getItem", arguments: { id: "K-1" } } });
    await call({ item: "K-1" });
    const finished = await client.callTool({ name: "stepgate_submit", arguments: { run: stateOf(seen[0]).run, output: {} } });

    expect(resultText(unknown as CallToolResult)).toMatch(/^RunNotActive: run no-such-run is not active/);
    expect(resultText(finished as CallToolResult)).toMatch(/^RunNotActive: /);
    expect(api.received.filter((request) => request.path.startsWith("/items"))).toEqual([]);
  });

  it("lets a call in flight finish before an idle run is abandoned", async () => {
    const { client, call, records, seen } = await start({
      edit: (stepfile) => {
        ((stepfile.tools as JsonObject).catalogue as JsonObject).exposes = ["getItem", "getFlaky", "getRevoked", "postSlow"];
        ((stepfile.steps as JsonObject[])[0] as JsonObject).tools = ["postSlow"];
      },
      actions: [],
      runIdleMs: 50,
    });

    await call({ item: "K-1" });
    const slow = await client.callTool({ name: "stepgate_call", arguments: { run: stateOf(seen[0]).run, operation: "postSlow", arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(slow.isError).toBeFalsy();
    expect(records.map((record) => record.type).slice(-2)).toEqual(["tool_call", "run_abandoned"]);
  });

  it("abandons a run the client stops driving, and records it in the ledger", async () => {
    const { client, call, records, seen } = await start({ actions: [], runIdleMs: 50 });

    await call({ item: "K-1" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const late = await client.callTool({ name: "stepgate_submit", arguments: { run: stateOf(seen[0]).run, output: {} } });

    expect(records.at(-1)).toMatchObject({ type: "run_abandoned" });
    expect(resultText(late as CallToolResult)).toMatch(/^RunNotActive: /);
  });
});
