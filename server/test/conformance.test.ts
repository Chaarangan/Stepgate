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
import { fixedStepfiles } from "../src/served.ts";
import { createStepgateServer } from "../src/server.ts";
import { userAgent } from "../src/version.ts";
import { startRoutes, startTools, type Received, type Route, type ToolFixture } from "./conformance-fixtures.ts";
import { secretsFrom } from "./fixtures.ts";
import { loopbackOrPublic, resultText, stateOf } from "./harness.ts";

type Reply = { state: string; step?: string; failures?: string[]; error?: string; contain?: string; is_error?: boolean };
type Action = { submit: JsonObject } | { call: string; arguments: JsonObject };
type ExpectedRequest = { method: string; path: string; headers?: Record<string, string> };
type Case = {
  name: string;
  api?: { routes: Route[] };
  mcp?: { token: string; tools: ToolFixture[] };
  credentials?: Record<string, string>;
  stepfile: JsonObject;
  inputs: JsonObject;
  actions: Action[];
  expect: { replies: Reply[]; ledger: string[]; requests?: ExpectedRequest[] };
};

const DIRECTORY = new URL("../conformance/", import.meta.url);
const CASES = readdirSync(DIRECTORY).filter((name) => name.endsWith(".case.yaml")).sort()
  .map((name) => parseYaml(readFileSync(new URL(name, DIRECTORY), "utf8")) as Case);

/** Plays one case's actions through a fresh server and returns every reply, ledger record and request the API received. */
async function play(item: Case): Promise<{ replies: CallToolResult[]; records: LedgerRecord[]; received: Received[] }> {
  const records: LedgerRecord[] = [];
  const api = item.api === undefined ? null : await startRoutes(item.api.routes);
  const mcp = item.mcp === undefined ? null : await startTools(item.mcp.tools, item.mcp.token);
  const text = JSON.stringify(item.stepfile)
    .replaceAll("${api.origin}", api?.origin ?? "").replaceAll("${api.host}", api?.host ?? "")
    .replaceAll("${mcp.origin}", mcp?.origin ?? "").replaceAll("${mcp.host}", mcp?.host ?? "");
  const stepfile = load(text);
  const server = createStepgateServer(fixedStepfiles([stepfile]), {
    credentials: secretsFrom(item.credentials ?? {}),
    settings: async (name) => {
      throw new SettingUnavailable(name, "conformance cases declare no settings");
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
    const request = "submit" in action
      ? { name: "stepgate_submit", arguments: { run, output: action.submit } }
      : { name: "stepgate_call", arguments: { run, operation: action.call, arguments: action.arguments } };
    replies.push((await client.callTool(request)) as CallToolResult);
  }
  await client.close();
  await api?.close();
  await mcp?.close();
  return { replies, records, received: api?.received ?? [] };
}

describe("conformance cases", () => {
  it("finds the cases", () => {
    expect(CASES.length).toBeGreaterThan(0);
  });

  it.each(CASES)("$name", async (item) => {
    const { replies, records, received } = await play(item);

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
      if (expected.is_error !== undefined) {
        expect(reply.isError === true).toBe(expected.is_error);
      }
    });
    expect(records.map((record) => record.type)).toEqual(item.expect.ledger);
    if (item.expect.requests !== undefined) {
      expect(received.map(({ method, path }) => ({ method, path }))).toEqual(item.expect.requests.map(({ method, path }) => ({ method, path })));
      item.expect.requests.forEach((request, index) => expect(received[index]?.headers).toMatchObject(request.headers ?? {}));
    }
  });
});
