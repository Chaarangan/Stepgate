import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CatalogEntryInvalid, StepfileInvalid, UnknownStepfile } from "./engine/errors.ts";
import { declaredToolHost, load, toolUrl } from "./engine/load.ts";
import type { Stepfile } from "./engine/types.ts";

export type CatalogEntry = { id: string; file: URL; stepfile: Stepfile };

// The published package carries stepfiles/ beside dist/; a repository checkout has it one level
// higher. The packaged location is tried first, so an installed package never looks outside itself.
const LOCATIONS = [new URL("../stepfiles/", import.meta.url), new URL("../../stepfiles/", import.meta.url)];

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function catalogDirectory(): URL {
  const found = LOCATIONS.find((location) => existsSync(location));
  if (found === undefined) {
    throw new Error(`no stepfile catalog found; looked in ${LOCATIONS.map((location) => location.pathname).join(" and ")}`);
  }
  return found;
}

function entryNames(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every rule a catalog folder breaks; an empty list means the entry is acceptable. */
export function entryProblems(directory: URL, name: string): string[] {
  const folder = new URL(`${name}/`, directory);
  const file = new URL(`${name}.stepfile.yaml`, folder);
  const readme = new URL("README.md", folder);
  const problems: string[] = [];
  if (!existsSync(readme)) {
    problems.push("README.md is missing");
  } else if (readFileSync(readme, "utf8").includes("TODO(")) {
    problems.push("README.md still has TODO( markers from the template");
  }
  if (!existsSync(file)) {
    return [...problems, `${name}.stepfile.yaml is missing`];
  }
  const text = readFileSync(file, "utf8");
  if (text.includes("TODO(")) {
    problems.push(`${name}.stepfile.yaml still has TODO( markers from the template`);
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
  if (stepfile.document.id !== name) {
    problems.push(`id is ${stepfile.document.id}, but the folder is ${name}`);
  }
  for (const [toolName, tool] of Object.entries(stepfile.document.tools ?? {})) {
    const url = toolUrl(tool);
    if (!url.startsWith("https://") || LOOPBACK.test(declaredToolHost(tool))) {
      problems.push(`tool ${toolName} must use a public https URL, not ${url}`);
    }
  }
  return problems;
}

/** Loads every entry in the catalog, raising CatalogEntryInvalid for the first that breaks a rule. */
export function listCatalog(directory: URL): CatalogEntry[] {
  return entryNames(directory).map((name) => {
    const problems = entryProblems(directory, name);
    if (problems.length > 0) {
      throw new CatalogEntryInvalid(name, problems);
    }
    const file = new URL(`${name}/${name}.stepfile.yaml`, directory);
    return { id: name, file, stepfile: load(readFileSync(file, "utf8")) };
  });
}

/** The file of the catalog entry with this name. */
export function catalogFile(directory: URL, name: string): URL {
  const names = entryNames(directory);
  if (!names.includes(name)) {
    throw new UnknownStepfile(name, names);
  }
  return new URL(`${name}/${name}.stepfile.yaml`, directory);
}
