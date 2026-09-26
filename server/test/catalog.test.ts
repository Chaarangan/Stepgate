import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { catalogDirectory, entryProblems, listCatalog } from "../src/catalog.ts";

const SERVER = new URL("../", import.meta.url);
const CATALOG = catalogDirectory();

function stepgate(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("node", ["src/cli.ts", ...args], { cwd: SERVER, encoding: "utf8", input: "", timeout: 10_000 });
}

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

/** A copy of one catalog entry in a throwaway catalog, for breaking on purpose. */
function scratchCatalog(entry: string): URL {
  scratch = mkdtempSync(join(tmpdir(), "stepgate-catalog-"));
  cpSync(new URL(`${entry}/`, CATALOG), join(scratch, entry), { recursive: true });
  return pathToFileURL(`${scratch}/`);
}

describe("catalog", () => {
  it("contains only entries that follow the catalog rules", () => {
    const entries = listCatalog(CATALOG);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entryProblems(CATALOG, entry.id), entry.id).toEqual([]);
    }
  });

  it("lists entries and serves one by name from the command line", () => {
    const listed = stepgate(["--list"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/^market-research: /m);

    const unknown = stepgate(["no-such-stepfile"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("UnknownStepfile: no catalog stepfile named no-such-stepfile; available: market-research");
  });

  it("scaffolds an entry that runs but is rejected until its TODO markers are replaced", () => {
    const id = `scaffold-check-${process.pid}`;
    try {
      const created = spawnSync("node", ["scripts/new-stepfile.ts", id], { cwd: SERVER, encoding: "utf8" });
      expect(created.status).toBe(0);

      const problems = entryProblems(CATALOG, id);
      expect(problems).toContain("README.md still has TODO( markers from the template");
      expect(problems).toContain(`${id}.stepfile.yaml still has TODO( markers from the template`);
      expect(problems.filter((problem) => !problem.includes("TODO("))).toEqual([]);
    } finally {
      rmSync(new URL(`${id}/`, CATALOG), { recursive: true, force: true });
    }
  });

  it("names each rule an entry breaks", () => {
    const catalog = scratchCatalog("market-research");
    const folder = new URL("market-research/", catalog);
    const file = new URL("market-research.stepfile.yaml", folder);
    rmSync(new URL("README.md", folder));
    writeFileSync(file, readFileSync(file, "utf8")
      .replace("id: market-research", "id: something-else")
      .replace("https://mcp.tavily.com/mcp/", "http://localhost:8080/mcp")
      .replace("hosts: [mcp.tavily.com]", "hosts: [\"localhost:8080\"]"));

    expect(entryProblems(catalog, "market-research")).toEqual([
      "README.md is missing",
      "id is something-else, but the folder is market-research",
      "tool tavily must use a public https URL, not http://localhost:8080/mcp",
    ]);
  });
});
