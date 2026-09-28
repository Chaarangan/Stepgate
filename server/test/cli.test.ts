import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { REFRESH_TOKEN, startAuthorizationServer, startMcp, type Fixture } from "./fixtures.ts";
import { stateOf } from "./harness.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];
const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

function emptyDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "stepgate-cli-"));
  scratch.push(directory);
  return directory;
}

/** Writes a stepfile outside the folders the CLI runs in, so they start empty. */
function stepfileFile(document: object): string {
  const file = join(emptyDirectory(), "check.stepfile.yaml");
  writeFileSync(file, stringify(document));
  return file;
}

const GREETING = {
  stepgate: "1",
  id: "greeting",
  inputs: { type: "object", properties: {} },
  steps: [{
    id: "greet",
    instructions: "Say hello.",
    produces: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    gates: [{ id: "says-hello", schema: { properties: { text: { pattern: "hello" } } } }],
  }],
};

/** Starts the real CLI over stdio in `cwd` with `home` as HOME, and finishes one greeting run. */
async function runGreeting(args: string[], cwd: string, home: string): Promise<CallToolResult> {
  const client = new Client({ name: "cli-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, ...args], cwd, env: { ...getDefaultEnvironment(), HOME: home }, stderr: "ignore" }));
  try {
    const started = (await client.callTool({ name: "greeting", arguments: {} })) as CallToolResult;
    return (await client.callTool({ name: "stepgate_submit", arguments: { run: stateOf(started).run, output: { text: "hello" } } })) as CallToolResult;
  } finally {
    await client.close();
  }
}

describe("the stepgate command", () => {
  it("writes no file without --record-cases, where the same run with it writes one", async () => {
    const file = stepfileFile(GREETING);
    const [plainCwd, plainHome, recordingCwd, recordingHome] = [emptyDirectory(), emptyDirectory(), emptyDirectory(), emptyDirectory()];

    const plain = await runGreeting([file], plainCwd, plainHome);
    const recording = await runGreeting(["--record-cases", "cases", file], recordingCwd, recordingHome);

    expect(stateOf(plain).state).toBe("finished");
    expect(stateOf(recording).state).toBe("finished");
    expect([readdirSync(plainCwd), readdirSync(plainHome)]).toEqual([[], []]);
    expect(readdirSync(join(recordingCwd, "cases"))).toEqual([expect.stringMatching(/^greeting-[0-9a-f-]+\.cases\.yaml$/)]);
  });

  it("--auth prints the variables to set and writes nothing to disk", async () => {
    const authorization = await startAuthorizationServer();
    const mcp = await startMcp(authorization.origin);
    fixtures.push(authorization, mcp);
    const file = stepfileFile({
      stepgate: "1",
      id: "suppliers",
      inputs: { type: "object", properties: {} },
      credentials: { suppliers: { kind: "oauth2", scopes: ["read"], token_url: `${authorization.origin}/token`, hosts: [mcp.host], description: "Looks up suppliers." } },
      tools: { suppliers: { mcp: { url: `${mcp.origin}/mcp` }, credential: "suppliers", exposes: ["lookup"] } },
      steps: [{ id: "look", tools: ["lookup"], instructions: "Look up Acme.", produces: { type: "object" }, gates: [{ id: "any", schema: { type: "object" } }] }],
    });
    const [cwd, home] = [emptyDirectory(), emptyDirectory()];

    const child = spawn(process.execPath, [CLI, "--auth", file, "suppliers"], { cwd, env: { ...process.env, HOME: home } });
    let stdout = "";
    let stderr = "";
    let opened = false;
    child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString()));
    // Plays the person in the browser: opens the printed URL, whose redirects reach the CLI's loopback callback.
    const visited = new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const url = /http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/.exec(stderr)?.[0];
        if (url !== undefined && !opened) {
          opened = true;
          fetch(url).then((response) => response.text()).then(() => resolve(), reject);
        }
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

    await visited;
    const code = await exited;

    expect(code).toBe(0);
    expect(stdout).toContain(`SUPPLIERS_REFRESH_TOKEN=${REFRESH_TOKEN}`);
    expect(stdout).toContain("SUPPLIERS_CLIENT_ID=client-1");
    expect([readdirSync(cwd), readdirSync(home)]).toEqual([[], []]);
  });
});
