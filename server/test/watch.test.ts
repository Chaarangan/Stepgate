import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { watchStepfiles } from "../src/served.ts";
import { resultText, startHarness, stateOf, type Harness } from "./harness.ts";

function stepfile(id: string, description: string): string {
  return stringify({
    stepgate: "1",
    id,
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

/** Serves these stepfile texts from files with --watch semantics, through the harness, counting tool-list changes. */
async function serveWatched(texts: string[]): Promise<{ harness: Harness; files: string[]; changes: () => number }> {
  const directory = mkdtempSync(join(tmpdir(), "stepgate-watch-"));
  const files = texts.map((text, index) => {
    const file = join(directory, `watched-${index}.stepfile.yaml`);
    writeFileSync(file, text);
    return file;
  });
  const served = watchStepfiles(files);
  const harness = await startHarness({ served, actions: [] });
  let changed = 0;
  harness.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed += 1;
  });
  cleanups.push(async () => {
    await harness.close();
    served.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { harness, files, changes: () => changed };
}

async function until(condition: () => boolean): Promise<void> {
  // File events can arrive seconds late on a loaded machine, as macOS delivered a removal under the full suite.
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the server to reload the stepfile");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function callTool(harness: Harness, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await harness.client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("--watch", { timeout: 20_000 }, () => {
  it("reloads an edited stepfile and tells the client its tools changed", async () => {
    const { harness, files, changes } = await serveWatched([stepfile("greeting", "Says hello.")]);

    writeFileSync(files[0] as string, stepfile("greeting", "Says hello, edited."));
    await until(() => changes() > 0);

    const { tools } = await harness.client.listTools();
    expect(tools.find((tool) => tool.name === "greeting")?.description).toContain("Says hello, edited.");
  });

  it("fails a call to a stepfile that became invalid with its issues, instead of serving the old version", async () => {
    const { harness, files, changes } = await serveWatched([stepfile("greeting", "Says hello.")]);

    writeFileSync(files[0] as string, stepfile("greeting", "Says hello.").replace('stepgate: "1"', 'stepgate: "2"'));
    await until(() => changes() > 0);

    const result = await callTool(harness, "greeting", {});
    expect(stateOf(result)).toMatchObject({ state: "failed", error: "StepfileInvalid" });
    expect(resultText(result)).toContain("/stepgate");
  });

  it("fails a call to a stepfile whose file was removed with StepfileUnreadable", async () => {
    const { harness, files, changes } = await serveWatched([stepfile("greeting", "Says hello.")]);

    unlinkSync(files[0] as string);
    await until(() => changes() > 0);

    expect(stateOf(await callTool(harness, "greeting", {}))).toMatchObject({ state: "failed", error: "StepfileUnreadable" });
  });

  it("refuses an edit that gives a stepfile the id another served file has, rather than listing two tools of one name", async () => {
    const { harness, files, changes } = await serveWatched([stepfile("greeting", "Says hello."), stepfile("farewell", "Says goodbye.")]);

    writeFileSync(files[1] as string, stepfile("greeting", "Says goodbye."));
    await until(() => changes() > 0);

    const { tools } = await harness.client.listTools();
    expect(tools.filter((tool) => tool.name === "greeting")).toHaveLength(1);
    const result = await callTool(harness, "farewell", {});
    expect(stateOf(result)).toMatchObject({ state: "failed", error: "StepfileInvalid" });
    expect(resultText(result)).toContain("id greeting is already served by");
  });

  it("finishes a run started before an edit on the version it started with", async () => {
    const { harness, files, changes } = await serveWatched([stepfile("greeting", "Says hello.")]);
    const started = await callTool(harness, "greeting", {});
    const identity = harness.records.find((record) => record.type === "run_started")?.identity;

    writeFileSync(files[0] as string, stepfile("greeting", "Says hello.").replace("pattern: hello", "pattern: goodbye"));
    await until(() => changes() > 0);

    const finished = await callTool(harness, "stepgate_submit", { run: stateOf(started).run, output: { text: "hello" } });
    expect(stateOf(finished)).toMatchObject({ state: "finished", identity });
  });
});
