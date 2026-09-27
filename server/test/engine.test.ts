import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { directorySink } from "../src/engine/ledger.ts";
import { load } from "../src/engine/load.ts";
import { evaluatePredicate } from "../src/engine/predicate.ts";
import type { Json, JsonObject } from "../src/engine/types.ts";
import { userAgent, VERSION } from "../src/version.ts";
import { GOOD_STOCK, GOOD_SUMMARY, startHarness, type Harness } from "./harness.ts";

const MARKET_RESEARCH = new URL("../../stepfiles/marketing/market-research/market-research.stepfile.yaml", import.meta.url);

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("load", () => {
  it("refuses a when condition that reads calls, which do not exist before the step runs", () => {
    const document = parseYaml(readFileSync(MARKET_RESEARCH, "utf8")) as { steps: Array<Record<string, unknown>> };
    const second = document.steps[1];
    if (second === undefined) {
      throw new Error("market-research has fewer than two steps");
    }
    second.when = { "==": [{ var: "calls.0.tool" }, "tavily_search"] };

    expect(() => load(JSON.stringify(document))).toThrow("when is evaluated before the step runs, so it cannot read output or calls");
  });

  it("refuses results with anything but a literal operation and optional path", () => {
    const document = parseYaml(readFileSync(MARKET_RESEARCH, "utf8")) as { steps: Array<{ gates: JsonObject[] }> };
    (document.steps[0] as { gates: JsonObject[] }).gates.push({ id: "bad-results", message: "m", predicate: { "==": [{ length: { results: [{ var: "inputs.tool" }] } }, 1] } });

    expect(() => load(JSON.stringify(document))).toThrow(/\/steps\/0\/gates\/bad-results results takes \[operation\] or \[operation, path\]/);
  });

  it("refuses results in when and select, which have no calls to read", () => {
    const document = parseYaml(readFileSync(MARKET_RESEARCH, "utf8")) as { steps: Array<Record<string, unknown>>; tools: { tavily: { exposes: Json[] } } };
    (document.steps[1] as Record<string, unknown>).when = { "==": [{ length: { results: ["tavily_search"] } }, 1] };
    expect(() => load(JSON.stringify(document))).toThrow("when is evaluated before the step runs, so it cannot read output or calls");

    delete (document.steps[1] as Record<string, unknown>).when;
    document.tools.tavily.exposes = [{ name: "tavily_search", select: { results: ["tavily_search"] } }];
    expect(() => load(JSON.stringify(document))).toThrow("tavily_search: select sees one result, so it cannot use results");
  });

  it("requires every {placeholder} to be a declared setting, and every setting to be used", () => {
    const document = parseYaml(readFileSync(MARKET_RESEARCH, "utf8")) as { settings?: unknown; tools: { tavily: { mcp: { url: string } } } };
    document.tools.tavily.mcp.url = "https://{region}.mcp.tavily.com/mcp/";
    expect(() => load(JSON.stringify(document))).toThrow("{region} is not a declared setting");

    document.tools.tavily.mcp.url = "https://mcp.tavily.com/mcp/";
    document.settings = { region: { description: "Tavily region." } };
    expect(() => load(JSON.stringify(document))).toThrow("setting region is declared but no tool URL or credential host uses it");
  });

  it("refuses a pattern RE2 cannot run, naming where it is", () => {
    const document = parseYaml(readFileSync(MARKET_RESEARCH, "utf8")) as { steps: Array<{ produces: JsonObject }> };
    (document.steps[0] as { produces: JsonObject }).produces = { type: "object", properties: { id: { type: "string", pattern: "^S-(?!00)[0-9]{2}$" } } };

    expect(() => load(JSON.stringify(document))).toThrow(/\/steps\/0\/produces pattern "\^S-\(\?!00\)\[0-9\]\{2\}\$" is not supported/);
  });

  it("gives the YAML and JSON forms of a stepfile the same identity", () => {
    const yaml = readFileSync(MARKET_RESEARCH, "utf8");
    expect(load(yaml).identity).toBe(load(JSON.stringify(parseYaml(yaml))).identity);
  });
});

describe("gate operators", () => {
  const calendars = { "alice@example.com": { busy: [] }, "bob@example.com": { busy: [{ start: "10:00", end: "11:00" }] } };

  it("get reads a key that contains dots, which var cannot", () => {
    const context = { inputs: { attendee: "bob@example.com" }, steps: {}, output: { calendars } };
    expect(evaluatePredicate({ "==": [{ length: { var: "busy" } }, 1] }, { ...context, output: { calendars } })).toBe(false);
    expect(evaluatePredicate({ "==": [{ length: { get: [{ get: [{ var: "output.calendars" }, { var: "inputs.attendee" }] }, "busy"] } }, 1] }, context)).toBe(true);
  });

  it("runs match_all in linear time, so a backtracking pattern cannot stall a run on a hostile response", () => {
    const started = performance.now();

    const result = evaluatePredicate({ "==": [{ length: { match_all: [{ var: "output.text" }, "(a+)+$"] } }, 0] }, { inputs: {}, steps: {}, output: { text: `${"a".repeat(50_000)}!` } });

    expect(result).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("join pairs each row with its evidence so a gate can compare them field by field", () => {
    const rule = { none: [{ join: [{ var: "output.rows" }, { var: "calls.0.result.items" }, "id", "id"] }, { or: [{ "==": [{ var: "right" }, null] }, { "!=": [{ var: "left.stock" }, { var: "right.stock" }] }] }] };
    const calls = [{ tool: "listItems", arguments: {}, result: { items: [{ id: "K-2", stock: 0 }, { id: "K-1", stock: 4 }] }, is_error: false }];
    const context = (rows: Json[]) => ({ inputs: {}, steps: {}, output: { rows }, calls });

    expect(evaluatePredicate(rule, context([{ id: "K-1", stock: 4 }, { id: "K-2", stock: 0 }]))).toBe(true);
    expect(evaluatePredicate(rule, context([{ id: "K-1", stock: 5 }]))).toBe(false);
    expect(evaluatePredicate(rule, context([{ id: "K-9", stock: 4 }]))).toBe(false);
  });
});

describe("version", () => {
  it("puts the operator's contact in the User-Agent in the form SEC EDGAR accepts", () => {
    expect(userAgent(null)).toBe(`stepgate/${VERSION} (+https://github.com/Chaarangan/stepgate)`);
    expect(userAgent("ops@example.com")).toBe(`stepgate/${VERSION} ops@example.com`);
  });

  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("ledger", () => {
  it("writes files that stepgate --verify accepts, and rejects after an edit", async () => {
    harness = await startHarness({ actions: [GOOD_STOCK, GOOD_SUMMARY] });
    await harness.call({ item: "K-1" });
    const directory = mkdtempSync(join(tmpdir(), "stepgate-ledger-"));
    const sink = directorySink(directory);
    for (const record of harness.records) {
      await sink(record);
    }
    const [file] = readdirSync(directory);
    const path = join(directory, file ?? "");
    const verify = () => spawnSync("node", ["src/cli.ts", "--verify", path], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 10_000 });

    const intact = verify();
    writeFileSync(path, readFileSync(path, "utf8").replace('"verdict":"pass"', '"verdict":"fail"'));
    const edited = verify();
    rmSync(directory, { recursive: true, force: true });

    expect(file).toMatch(/^stock-check-[0-9a-f-]+\.jsonl$/);
    expect(harness.records.every((record) => record.stepfile === "stock-check" && record.run === harness?.records[0]?.run)).toBe(true);
    expect(intact.status).toBe(0);
    expect(intact.stdout).toMatch(/: intact, \d+ records/);
    expect(edited.status).toBe(1);
    expect(edited.stdout).toMatch(/: broken at seq \d+: prev does not match/);
  });
});
