// Reports where the catalog's stepfile lines go and what its gates check, so a format change can be measured.
// Lines are counted after re-serialising each part as block-style YAML, so entries compare regardless of style.
//
//   npm run measure-catalog
import { existsSync } from "node:fs";
import { stringify } from "yaml";
import { catalogDirectory, listCatalog } from "../src/catalog.ts";
import type { Json } from "../src/engine/types.ts";

type Parts = { gates: number; mechanical: number; produces: number; tools: number; instructions: number; other: number };
type GateKinds = { schema: number; predicate: number; http: number; approve: number };
type PredicateReach = { calls: number; steps_or_inputs: number; output_only: number };

function lines(value: unknown): number {
  return value === undefined ? 0 : stringify(value).split("\n").length;
}

/** Filters over `calls` by tool name, the pattern `results` replaces. */
function callFilters(value: Json): number {
  return (JSON.stringify(value).match(/"filter":\[\{"var":"calls"\}/g) ?? []).length;
}

const entries = listCatalog(catalogDirectory());
const totals: Parts = { gates: 0, mechanical: 0, produces: 0, tools: 0, instructions: 0, other: 0 };
const kinds: GateKinds = { schema: 0, predicate: 0, http: 0, approve: 0 };
const reach: PredicateReach = { calls: 0, steps_or_inputs: 0, output_only: 0 };
let filters = 0;
let withCases = 0;

for (const { domain, id, file, stepfile: { document } } of entries) {
  const parts: Parts = {
    gates: document.steps.reduce((sum, step) => sum + lines(step.gates), 0),
    mechanical: document.steps.reduce((sum, step) => sum + lines(step.do), 0),
    produces: document.steps.reduce((sum, step) => sum + lines(step.produces), 0),
    tools: lines(document.tools),
    instructions: document.steps.reduce((sum, step) => sum + (step.instructions ?? "").split("\n").length, 0),
    other: 0,
  };
  parts.other = lines(document) - parts.gates - parts.mechanical - parts.produces - parts.tools - parts.instructions;
  for (const key of Object.keys(totals) as Array<keyof Parts>) {
    totals[key] += parts[key];
  }
  for (const step of document.steps) {
    filters += callFilters((step.gates ?? []) as unknown as Json);
    for (const gate of step.gates ?? []) {
      const kind = (["schema", "predicate", "http", "approve"] as const).find((name) => name in gate);
      if (kind === undefined) {
        throw new Error(`gate ${gate.id} in ${id} has no known kind`);
      }
      kinds[kind] += 1;
      if ("predicate" in gate) {
        const text = JSON.stringify(gate.predicate);
        reach[text.includes('"calls') ? "calls" : text.includes('"steps.') || text.includes('"inputs') ? "steps_or_inputs" : "output_only"] += 1;
      }
    }
  }
  if (existsSync(new URL(`${id}.cases.yaml`, file))) {
    withCases += 1;
  }
  console.log(`${`${domain}/${id}`.padEnd(44)} ${JSON.stringify(parts)}`);
}

const all = Object.values(totals).reduce((sum, value) => sum + value, 0);
const share = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, `${Math.round((100 * value) / all)}%`]));
console.log(`\nLines, counted as block-style YAML: ${all}`);
console.log(`Share of lines: ${JSON.stringify(share)}`);
console.log(`Filters over calls by tool: ${filters}`);
console.log(`Gates: ${JSON.stringify(kinds)}`);
console.log(`Predicates reading: ${JSON.stringify(reach)}`);
console.log(`Entries with a cases file: ${withCases} of ${entries.length}`);
