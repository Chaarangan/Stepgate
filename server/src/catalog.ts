import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CasesInvalid, CatalogEntryInvalid, StepfileInvalid, UnknownStepfile } from "./engine/errors.ts";
import { parseCases } from "./gate-test.ts";
import { isPublicHttpsUrl } from "./engine/http.ts";
import { load, toolUrl } from "./engine/load.ts";
import { withSampleSettings } from "./engine/settings.ts";
import { varPaths } from "./engine/predicate.ts";
import type { Step, Stepfile, StepfileDocument } from "./engine/types.ts";

export type CatalogEntry = { domain: string; id: string; file: URL; stepfile: Stepfile };

type Location = { domain: string; id: string };

// The published package carries stepfiles/ beside dist/; a repository checkout has it one level
// higher. The packaged location is tried first, so an installed package never looks outside itself.
const LOCATIONS = [new URL("../stepfiles/", import.meta.url), new URL("../../stepfiles/", import.meta.url)];

const FOLDER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function catalogDirectory(): URL {
  const found = LOCATIONS.find((location) => existsSync(location));
  if (found === undefined) {
    throw new Error(`no stepfile catalog found; looked in ${LOCATIONS.map((location) => location.pathname).join(" and ")}`);
  }
  return found;
}

function subdirectories(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every stepfiles/<domain>/<id>/ folder, sorted by domain and then id. */
function locations(directory: URL): Location[] {
  return subdirectories(directory).flatMap((domain) => subdirectories(new URL(`${domain}/`, directory)).map((id) => ({ domain, id })));
}

function entryFile(directory: URL, { domain, id }: Location): URL {
  return new URL(`${domain}/${id}/${id}.stepfile.yaml`, directory);
}

/** Rules that span entries: domain names, stepfiles outside an entry folder, and ids used twice. */
export function catalogProblems(directory: URL): string[] {
  const problems: string[] = [];
  for (const domain of subdirectories(directory)) {
    if (!FOLDER_NAME.test(domain)) {
      problems.push(`domain folder ${domain} must be lowercase letters, digits and hyphens`);
    }
    const loose = readdirSync(new URL(`${domain}/`, directory)).filter((name) => name.endsWith(".stepfile.yaml"));
    for (const name of loose) {
      problems.push(`stepfiles/${domain}/${name} must live in its own folder, stepfiles/${domain}/<id>/`);
    }
  }
  const seen = new Map<string, string>();
  for (const { domain, id } of locations(directory)) {
    const other = seen.get(id);
    if (other !== undefined) {
      problems.push(`${id} appears in both ${other} and ${domain}; catalog names must be unique`);
    }
    seen.set(id, domain);
  }
  return problems;
}

const READ_METHODS = new Set(["get", "head", "options"]);

/**
 * Exposed names that may write: an OpenAPI operation whose inline method is not GET, HEAD or OPTIONS, and any MCP tool
 * or operation whose method cannot be read offline, unless its exposes entry declares `effect: read`.
 */
function mayWrite(document: StepfileDocument): Set<string> {
  const writes = new Set<string>();
  for (const tool of Object.values(document.tools ?? {})) {
    const reads = new Set<string>();
    for (const item of Object.values((tool.openapi?.document?.paths ?? {}) as Record<string, Record<string, { operationId?: string }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (READ_METHODS.has(method) && typeof operation.operationId === "string") {
          reads.add(operation.operationId);
        }
      }
    }
    for (const entry of tool.exposes ?? []) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!reads.has(name) && !(typeof entry !== "string" && entry.effect === "read")) {
        writes.add(name);
      }
    }
  }
  return writes;
}

/** The catalog's rule on writes: only a mechanical step writes, after a person approved an agent step, from approved values. */
function writeProblems(document: StepfileDocument): string[] {
  const writes = mayWrite(document);
  const problems: string[] = [];
  let lastAgent: Step | null = null;
  for (const step of document.steps) {
    if (step.do === undefined) {
      for (const name of (step.tools ?? []).filter((tool) => writes.has(tool))) {
        problems.push(`step ${step.id} calls ${name}, which may write, from an agent step; a write belongs in a mechanical step after an agent step with an approve gate, or declare effect: read if it changes nothing`);
      }
      lastAgent = step;
      continue;
    }
    for (const call of (step.do.calls ?? []).filter((planned) => writes.has(planned.operation))) {
      if (lastAgent === null || !(lastAgent.gates ?? []).some((gate) => "approve" in gate)) {
        problems.push(`step ${step.id} writes with ${call.operation}, but ${lastAgent === null ? "no agent step comes before it" : `the agent step before it, ${lastAgent.id}, has no approve gate`}`);
      }
      const fromResponses = varPaths([call.arguments ?? null, call.each ?? null]).find((path) => path.split(".")[0] === "responses");
      if (fromResponses !== undefined) {
        problems.push(`step ${step.id} writes with ${call.operation} from ${fromResponses.split(".").slice(0, 2).join(".")}, but a write may use only inputs, settings and earlier steps' outputs, which the person approved`);
      }
    }
  }
  return problems;
}

/** Every rule one entry folder breaks; an empty list means the entry is acceptable. */
export function entryProblems(directory: URL, domain: string, id: string): string[] {
  const folder = new URL(`${domain}/${id}/`, directory);
  const file = new URL(`${id}.stepfile.yaml`, folder);
  const readme = new URL("README.md", folder);
  const problems: string[] = [];
  if (!existsSync(readme)) {
    problems.push("README.md is missing");
  } else if (readFileSync(readme, "utf8").includes("TODO(")) {
    problems.push("README.md still has TODO( markers from the template");
  }
  if (!existsSync(file)) {
    return [...problems, `${id}.stepfile.yaml is missing`];
  }
  const text = readFileSync(file, "utf8");
  if (text.includes("TODO(")) {
    problems.push(`${id}.stepfile.yaml still has TODO( markers from the template`);
  }
  let stepfile: Stepfile;
  try {
    stepfile = load(text);
  } catch (error) {
    if (error instanceof StepfileInvalid) {
      return [...problems, ...error.issues.map((issue) => `${issue.path || "/"} ${issue.message}`)];
    }
    throw error;
  }
  const cases = new URL(`${id}.cases.yaml`, folder);
  if (existsSync(cases)) {
    try {
      parseCases(stepfile, readFileSync(cases, "utf8"));
    } catch (error) {
      if (!(error instanceof CasesInvalid)) {
        throw error;
      }
      problems.push(...error.problems.map((problem) => `${id}.cases.yaml: ${problem}`));
    }
  }
  problems.push(...writeProblems(stepfile.document));
  if (stepfile.document.id !== id) {
    problems.push(`id is ${stepfile.document.id}, but the folder is ${id}`);
  }
  for (const [toolName, tool] of Object.entries(stepfile.document.tools ?? {})) {
    for (const url of [toolUrl(tool), ...(tool.openapi?.url === undefined ? [] : [tool.openapi.url])]) {
      if (!isPublicHttpsUrl(withSampleSettings(url))) {
        problems.push(`tool ${toolName} must use a public https URL, not ${url}`);
      }
    }
  }
  return problems;
}

/** Loads every entry, raising CatalogEntryInvalid for the catalog layout or the first entry that breaks a rule. */
export function listCatalog(directory: URL): CatalogEntry[] {
  const layout = catalogProblems(directory);
  if (layout.length > 0) {
    throw new CatalogEntryInvalid("stepfiles", layout);
  }
  return locations(directory).map((location) => {
    const problems = entryProblems(directory, location.domain, location.id);
    if (problems.length > 0) {
      throw new CatalogEntryInvalid(`${location.domain}/${location.id}`, problems);
    }
    const file = entryFile(directory, location);
    return { ...location, file, stepfile: load(readFileSync(file, "utf8")) };
  });
}

/** The file of the catalog entry with this name, whichever domain it is in. */
export function catalogFile(directory: URL, name: string): URL {
  const all = locations(directory);
  const found = all.find((location) => location.id === name);
  if (found === undefined) {
    throw new UnknownStepfile(name, all.map((location) => location.id));
  }
  return entryFile(directory, found);
}
