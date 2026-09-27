// Runs catalog stepfiles live, one after another, through the demo client, and prints a summary.
// Example inputs live in examples/catalog-inputs.json. Needs the same variables as the demo client.
//
//   npm run demo:catalog -- [name ...]      (no names runs every entry in catalog-inputs.json)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Example = { inputs: unknown; args?: string[] };

const examples = JSON.parse(readFileSync(new URL("catalog-inputs.json", import.meta.url), "utf8")) as Record<string, Example>;
const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(examples);
const ledgers = join(tmpdir(), `stepgate-ledgers-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(ledgers, { recursive: true });

const rows: string[] = [];
for (const name of names) {
  const example = examples[name];
  if (example === undefined) {
    throw new Error(`no example inputs for ${name} in examples/catalog-inputs.json`);
  }
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const run = spawnSync("node", ["examples/demo-client.ts", name, JSON.stringify(example.inputs), join(ledgers, name)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, STEPGATE_EXTRA_ARGS: (example.args ?? []).join(" ") },
  });
  rows.push(`${run.status === 0 ? "PASS" : "FAIL"}  ${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${name}`);
}

console.log(`\n${rows.join("\n")}\n\nLedgers: ${ledgers}`);
