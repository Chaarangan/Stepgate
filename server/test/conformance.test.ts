import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SettingUnavailable } from "../src/engine/errors.ts";
import { load } from "../src/engine/load.ts";
import type { JsonObject, LedgerRecord } from "../src/engine/types.ts";
import { createStepgateServer } from "../src/server.ts";
import { userAgent } from "../src/version.ts";
import { secretsFrom } from "./fixtures.ts";
import { loopbackOrPublic, resultText, stateOf } from "./harness.ts";

type Reply = { state: string; step?: string; failures?: string[]; error?: string; contain?: string };
type Case = { name: string; stepfile: JsonObject; inputs: JsonObject; actions: Array<{ submit: JsonObject }>; expect: { replies: Reply[]; ledger: string[] } };

const DIRECTORY = new URL("../conformance/", import.meta.url);
const CASES = readdirSync(DIRECTORY).filter((name) => name.endsWith(".case.yaml")).sort()
  .map((name) => parseYaml(readFileSync(new URL(name, DIRECTORY), "utf8")) as Case);

/** Plays one case's actions through a fresh server and returns every reply and ledger record. */
async function play(item: Case): Promise<{ replies: CallToolResult[]; records: LedgerRecord[] }> {
  const records: LedgerRecord[] = [];
  const stepfile = load(JSON.stringify(item.stepfile));
  const server = createStepgateServer([stepfile], {
    credentials: secretsFrom({}),
    settings: async (name) => {
      throw new SettingUnavailable(name, "conformance cases are keyless");
    },
    ledger: (record) => void records.push(record),
    limits: { callsPerStep: 8, toolResultChars: 10_000, requestTimeoutMs: 5_000, responseBytes: 1_000_000 },
    runIdleMs: 60_000,
    userAgent: userAgent(null),
    drafts: { urlAllowed: loopbackOrPublic, credentials: new Map(), settings: new Set() },
  });
  const client = new Client({ name: "conformance", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide as Transport);
  await client.connect(clientSide as Transport);
  const replies = [(await client.callTool({ name: stepfile.document.id, arguments: item.inputs })) as CallToolResult];
  const run = stateOf(replies[0]).run;
  for (const action of item.actions) {
    replies.push((await client.callTool({ name: "stepgate_submit", arguments: { run, output: action.submit } })) as CallToolResult);
  }
  await client.close();
  return { replies, records };
}

describe("conformance cases", () => {
  it("finds the cases", () => {
    expect(CASES.length).toBeGreaterThan(0);
  });

  it.each(CASES)("$name", async (item) => {
    const { replies, records } = await play(item);

    expect(replies).toHaveLength(item.expect.replies.length);
    item.expect.replies.forEach((expected, index) => {
      const reply = replies[index] as CallToolResult;
      const state = stateOf(reply) as JsonObject & { step?: { step: string }; failures?: Array<{ gate: string }> };
      expect(state.state).toBe(expected.state);
      if (expected.step !== undefined) {
        expect(state.step?.step).toBe(expected.step);
      }
      if (expected.failures !== undefined) {
        expect((state.failures ?? []).map((failure) => failure.gate).sort()).toEqual([...expected.failures].sort());
      }
      if (expected.error !== undefined) {
        expect(state.error).toBe(expected.error);
      }
      if (expected.contain !== undefined) {
        expect(resultText(reply)).toContain(expected.contain);
      }
    });
    expect(records.map((record) => record.type)).toEqual(item.expect.ledger);
  });
});
