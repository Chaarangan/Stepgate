import { afterEach, describe, expect, it } from "vitest";
import { GOOD_STOCK, GOOD_SUMMARY, resultText, startHarness, type Harness, type Setup } from "./harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(setup: Setup): Promise<Harness> {
  harness = await startHarness(setup);
  return harness;
}

const TURNS = [
  [
    { type: "tool_use", id: "a", name: "getItem", input: { id: "K-1" } },
    { type: "tool_use", id: "b", name: "lookup", input: { query: "Acme" } },
  ],
  GOOD_STOCK,
  GOOD_SUMMARY,
] as Setup["turns"];

describe("Stepgate MCP server", () => {
  it("lists each stepfile as a tool with the stepfile's input schema", async () => {
    const { client } = await start({ turns: [] });

    const { tools } = await client.listTools();

    expect(tools).toEqual([
      expect.objectContaining({ name: "stock-check", description: "Checks an item's stock and its supplier.", inputSchema: expect.objectContaining({ required: ["item"] }) }),
    ]);
  });

  it("runs a stepfile on the client's model through sampling and returns every step's output", async () => {
    const { client, sampled } = await start({ turns: TURNS });
    const progress: string[] = [];

    const result = await client.callTool({ name: "stock-check", arguments: { item: "K-1" } }, undefined, {
      onprogress: (update) => void progress.push(update.message ?? ""),
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      outputs: { stock: { name: "Blue kettle", count: 4, supplier: "Acme" }, summary: { summary: "Blue kettle has 4 in stock." } },
    });
    expect(sampled).toHaveLength(3);
    expect(sampled[0]?.tools?.map((tool) => tool.name)).toEqual(["getItem", "lookup", "submit"]);
    expect(sampled[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "a", isError: false },
        { type: "tool_result", toolUseId: "b", isError: false, content: [{ type: "text", text: "Supplier Acme: based in Leeds" }] },
      ],
    });
    expect(progress).toContain("step_passed stock");
    expect(progress.at(-1)).toBe("run_finished");
  });

  it("refuses to run for a client that cannot sample with tools, before contacting anything", async () => {
    const { call, records, api } = await start({ turns: [], sampling: false });

    const result = await call({ item: "K-1" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("sampling.tools");
    expect(records).toEqual([]);
    expect(api.received).toEqual([]);
  });
});
