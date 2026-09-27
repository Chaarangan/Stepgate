import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CatalogEntryInvalid, StepfileInvalid, UnknownStepfile } from "./engine/errors.ts";
import { declaredToolHost, load, toolUrl } from "./engine/load.ts";
import type { Stepfile } from "./engine/types.ts";

export type CatalogEntry = { domain: string; id: string; file: URL; stepfile: Stepfile };

type Location = { domain: string; id: string };

// The published package carries stepfiles/ beside dist/; a repository checkout has it one level
// higher. The packaged location is tried first, so an installed package never looks outside itself.
const LOCATIONS = [new URL("../stepfiles/", import.meta.url), new URL("../../stepfiles/", import.meta.url)];

const PRIVATE_IPV4 = /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./;
const FOLDER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * True for a host with a dot that is not a loopback, private or link-local address or a local-only name.
 * It reads the name only; a public name that resolves to a private address still passes.
 */
export function isPublicHost(authority: string): boolean {
  const host = authority.toLowerCase().replace(/:\d+$/, "");
  if (host.startsWith("[") || !host.includes(".") || /\.(local|localhost|internal)$/.test(host)) {
    return false;
  }
  return !(/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_IPV4.test(host));
}

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
  if (stepfile.document.id !== id) {
    problems.push(`id is ${stepfile.document.id}, but the folder is ${id}`);
  }
  for (const [toolName, tool] of Object.entries(stepfile.document.tools ?? {})) {
    const url = toolUrl(tool);
    if (!url.startsWith("https://") || !isPublicHost(declaredToolHost(tool))) {
      problems.push(`tool ${toolName} must use a public https URL, not ${url}`);
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
