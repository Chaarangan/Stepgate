import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { catalogDirectory, catalogProblems, entryProblems, listCatalog } from "../src/catalog.ts";

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

/** A throwaway catalog holding a copy of marketing/market-research, for breaking on purpose. */
function scratchCatalog(): URL {
  scratch = mkdtempSync(join(tmpdir(), "stepgate-catalog-"));
  cpSync(new URL("marketing/market-research/", CATALOG), join(scratch, "marketing", "market-research"), { recursive: true });
  return pathToFileURL(`${scratch}/`);
}

describe("catalog", () => {
  it("contains only entries that follow the catalog rules", () => {
    expect(catalogProblems(CATALOG)).toEqual([]);
    const entries = listCatalog(CATALOG);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entryProblems(CATALOG, entry.domain, entry.id), `${entry.domain}/${entry.id}`).toEqual([]);
    }
  });

  it("lists entries by domain and serves one by name from the command line", () => {
    const listed = stepgate(["--list"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/^marketing$/m);
    expect(listed.stdout).toMatch(/^marketing\n(  .+\n)*  market-research: /m);

    const unknown = stepgate(["no-such-stepfile"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toMatch(/UnknownStepfile: no catalog stepfile named no-such-stepfile; available: .*market-research/);
  });

  it("scaffolds an entry that runs but is rejected until its TODO markers are replaced", () => {
    const domain = `zz-scaffold-${process.pid}`;
    const id = "scaffold-check";
    try {
      const created = spawnSync("node", ["scripts/new-stepfile.ts", `${domain}/${id}`], { cwd: SERVER, encoding: "utf8" });
      expect(created.status).toBe(0);

      const problems = entryProblems(CATALOG, domain, id);
      expect(problems).toContain("README.md still has TODO( markers from the template");
      expect(problems).toContain(`${id}.stepfile.yaml still has TODO( markers from the template`);
      expect(problems.filter((problem) => !problem.includes("TODO("))).toEqual([]);
    } finally {
      rmSync(new URL(`${domain}/`, CATALOG), { recursive: true, force: true });
    }
  });

  it("names each rule an entry breaks", () => {
    const catalog = scratchCatalog();
    const folder = new URL("marketing/market-research/", catalog);
    const file = new URL("market-research.stepfile.yaml", folder);
    rmSync(new URL("README.md", folder));
    writeFileSync(file, readFileSync(file, "utf8")
      .replace("id: market-research", "id: something-else")
      .replace("https://mcp.tavily.com/mcp/", "http://localhost:8080/mcp")
      .replace("hosts: [mcp.tavily.com]", "hosts: [\"localhost:8080\"]"));

    expect(entryProblems(catalog, "marketing", "market-research")).toEqual([
      "README.md is missing",
      "id is something-else, but the folder is market-research",
      "tool tavily must use a public https URL, not http://localhost:8080/mcp",
    ]);
  });

  it("rejects an id used in two domains and a stepfile outside an entry folder", () => {
    const catalog = scratchCatalog();
    cpSync(new URL("marketing/market-research/", catalog), new URL("sales/market-research/", catalog), { recursive: true });
    mkdirSync(new URL("retail/", catalog));
    writeFileSync(new URL("retail/loose.stepfile.yaml", catalog), "stepgate: \"1\"\n");

    expect(catalogProblems(catalog)).toEqual([
      "stepfiles/retail/loose.stepfile.yaml must live in its own folder, stepfiles/retail/<id>/",
      "market-research appears in both marketing and sales; catalog names must be unique",
    ]);
  });
});
