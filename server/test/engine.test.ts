import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { verifyLedger } from "../src/engine/ledger.ts";
import { load } from "../src/engine/load.ts";
import { GOOD_STOCK, GOOD_SUMMARY, startHarness, type Harness } from "./harness.ts";

const MARKET_RESEARCH = new URL("../../stepfiles/market-research/market-research.stepfile.yaml", import.meta.url);

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("load", () => {
  it("gives the YAML and JSON forms of a stepfile the same identity", () => {
    const yaml = readFileSync(MARKET_RESEARCH, "utf8");
    expect(load(yaml).identity).toBe(load(JSON.stringify(parseYaml(yaml))).identity);
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
