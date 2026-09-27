import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { verifyLedger } from "../src/engine/ledger.ts";
import { load } from "../src/engine/load.ts";
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

  it("requires every {placeholder} to be a declared setting, and every setting to be used", () => {
    const document = parseYaml(readFileSync(MARKET_RESEARCH, "utf8")) as { settings?: unknown; tools: { tavily: { mcp: { url: string } } } };
    document.tools.tavily.mcp.url = "https://{region}.mcp.tavily.com/mcp/";
    expect(() => load(JSON.stringify(document))).toThrow("{region} is not a declared setting");

    document.tools.tavily.mcp.url = "https://mcp.tavily.com/mcp/";
    document.settings = { region: { description: "Tavily region." } };
    expect(() => load(JSON.stringify(document))).toThrow("setting region is declared but no tool URL or credential host uses it");
  });

  it("gives the YAML and JSON forms of a stepfile the same identity", () => {
    const yaml = readFileSync(MARKET_RESEARCH, "utf8");
    expect(load(yaml).identity).toBe(load(JSON.stringify(parseYaml(yaml))).identity);
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
  it("emits a chain that verifies, and fails verification after an edit", async () => {
    harness = await startHarness({ turns: [GOOD_STOCK, GOOD_SUMMARY] });

    await harness.call({ item: "K-1" });

    const { records } = harness;
    expect(verifyLedger(records)).toBe(true);
    const edited = records.map((record) => (record.type === "gate" ? { ...record, verdict: "fail" } : record));
    expect(verifyLedger(edited)).toBe(false);
  });
});
