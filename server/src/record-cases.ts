import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { CaseSink } from "./engine/types.ts";

/** Writes each finished or failed run to `<dir>/<stepfile>-<run>.cases.yaml`, in the format `stepgate --test` reads. */
export function directoryCaseSink(directory: string): CaseSink {
  mkdirSync(directory, { recursive: true });
  return async ({ stepfile, run, inputs, steps }) => {
    const header = `# Recorded by stepgate --record-cases from run ${run}. It holds the APIs' full responses; trim them before sharing.\n`;
    writeFileSync(join(directory, `${stepfile}-${run}.cases.yaml`), header + stringify({ cases: [{ name: `run ${run} of ${stepfile}`, inputs, steps }] }));
  };
}
