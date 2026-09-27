import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { SettingUnavailable } from "../src/engine/errors.ts";
import type { LedgerRecord } from "../src/engine/types.ts";
import { createStepgateServer } from "../src/server.ts";
import { watchStepfiles, type Served } from "../src/served.ts";
import { userAgent } from "../src/version.ts";
import { secretsFrom } from "./fixtures.ts";
import { loopbackOrPublic, resultText, stateOf } from "./harness.ts";

function stepfile(description: string): string {
  return stringify({
    stepgate: "1",
    id: "greeting",
    description,
    inputs: { type: "object", properties: {} },
    steps: [{
      id: "greet",
      instructions: "Say hello.",
      produces: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      gates: [{ id: "says-hello", schema: { properties: { text: { pattern: "hello" } } } }],
    }],
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** Serves one stepfile file with --watch semantics and connects a client that counts tool-list changes. */
async function serveWatched(text: string): Promise<{ client: Client; file: string; changes: () => number; records: LedgerRecord[]; served: Served }> {
  const directory = mkdtempSync(join(tmpdir(), "stepgate-watch-"));
  const file = join(directory, "greeting.stepfile.yaml");
  writeFileSync(file, text);
  const served = watchStepfiles([file]);
  const records: LedgerRecord[] = [];
  const server = createStepgateServer(served, {
    credentials: secretsFrom({}),
    settings: async (name) => {
      throw new SettingUnavailable(name, "this test declares no settings");
    },
    ledger: (record) => void records.push(record),
    recordCases: null,
    limits: { callsPerStep: 8, toolResultChars: 10_000, requestTimeoutMs: 5_000, responseBytes: 1_000_000 },
    runIdleMs: 60_000,
    userAgent: userAgent(null),
    drafts: { urlAllowed: loopbackOrPublic, credentials: new Map(), settings: new Set() },
  });
  const client = new Client({ name: "watcher", version: "1.0.0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed += 1;
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide as Transport);
  await client.connect(clientSide as Transport);
  cleanups.push(async () => {
    await client.close();
    served.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { client, file, changes: () => changed, records, served };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the server to reload the stepfile");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("--watch", () => {
  it("reloads an edited stepfile and tells the client its tools changed", async () => {
    const { client, file, changes } = await serveWatched(stepfile("Says hello."));

    writeFileSync(file, stepfile("Says hello, edited."));
    await until(() => changes() > 0);

    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "greeting")?.description).toContain("Says hello, edited.");
  });

  it("fails a call to a stepfile that became invalid with its issues, instead of serving the old version", async () => {
    const { client, file, changes } = await serveWatched(stepfile("Says hello."));

    writeFileSync(file, stepfile("Says hello.").replace('stepgate: "1"', 'stepgate: "2"'));
    await until(() => changes() > 0);

    const result = (await client.callTool({ name: "greeting", arguments: {} })) as CallToolResult;
    expect(stateOf(result)).toMatchObject({ state: "failed", error: "StepfileInvalid" });
    expect(resultText(result)).toContain("/stepgate");
  });

  it("finishes a run started before an edit on the version it started with", async () => {
    const { client, file, changes, records } = await serveWatched(stepfile("Says hello."));
    const started = (await client.callTool({ name: "greeting", arguments: {} })) as CallToolResult;
    const identity = records.find((record) => record.type === "run_started")?.identity;

    writeFileSync(file, stepfile("Says hello.").replace("pattern: hello", "pattern: goodbye"));
    await until(() => changes() > 0);

    const finished = (await client.callTool({ name: "stepgate_submit", arguments: { run: stateOf(started).run, output: { text: "hello" } } })) as CallToolResult;
    expect(stateOf(finished)).toMatchObject({ state: "finished", identity });
  });
});
