import { RunNotActive } from "./errors.ts";
import { startRun, type Progress, type Run } from "./run.ts";
import type { ToolResult } from "./tools/tool.ts";
import type { Json, JsonObject, RunContext, Stepfile } from "./types.ts";

/**
 * The runs one client session has open, by id. A run leaves when it finishes, fails, or waits longer than `idleMs`
 * for its next call; any later call for it raises RunNotActive.
 */
export type Runs = {
  start: (stepfile: Stepfile, inputs: JsonObject, context: RunContext) => Promise<{ run: string; progress: Progress }>;
  call: (id: string, operation: string, args: Json | undefined) => Promise<ToolResult>;
  submit: (id: string, output: Json | undefined) => Promise<Progress>;
  /** Abandons every open run, as when the session closes. */
  abandonAll: () => Promise<void>;
};

type Open = { run: Run; timer: NodeJS.Timeout };

export function createRuns(idleMs: number): Runs {
  const open = new Map<string, Open>();

  const abandon = async (id: string): Promise<void> => {
    const entry = open.get(id);
    if (entry === undefined) {
      return;
    }
    clearTimeout(entry.timer);
    open.delete(id);
    await entry.run.abandon();
  };
  const expiry = (id: string) => setTimeout(() => void abandon(id), idleMs).unref();

  const touch = (id: string): Run => {
    const entry = open.get(id);
    if (entry === undefined) {
      throw new RunNotActive(id);
    }
    clearTimeout(entry.timer);
    entry.timer = expiry(id);
    return entry.run;
  };
  const leave = (id: string): void => {
    const entry = open.get(id);
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      open.delete(id);
    }
  };
  // A raised error has ended the run, and a finished run has nothing left to do, so both leave the registry.
  const settled = async <T>(id: string, work: Promise<T>, finished: (value: T) => boolean): Promise<T> => {
    try {
      const value = await work;
      if (finished(value)) {
        leave(id);
      }
      return value;
    } catch (error) {
      leave(id);
      throw error;
    }
  };

  return {
    start: async (stepfile, inputs, context) => {
      const { run, progress } = await startRun(stepfile, inputs, context);
      if (progress.state !== "finished") {
        open.set(run.id, { run, timer: expiry(run.id) });
      }
      return { run: run.id, progress };
    },
    call: async (id, operation, args) => settled(id, touch(id).call(operation, args), () => false),
    submit: async (id, output) => settled(id, touch(id).submit(output), (progress) => progress.state === "finished"),
    abandonAll: async () => {
      await Promise.all([...open.keys()].map(abandon));
    },
  };
}
