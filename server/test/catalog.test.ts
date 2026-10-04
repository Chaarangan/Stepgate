import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import { catalogDirectory, catalogProblems, entryProblems, listCatalog } from "../src/catalog.ts";
import { parseCases, testGates } from "../src/gate-test.ts";

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

  it("passes every entry's recorded gate cases, offline", async () => {
    const entries = listCatalog(CATALOG).filter((entry) => existsSync(new URL(`${entry.id}.cases.yaml`, entry.file)));
    const reports = (await Promise.all(entries.map(async (entry) => testGates(entry.stepfile, parseCases(entry.stepfile, readFileSync(new URL(`${entry.id}.cases.yaml`, entry.file), "utf8")))))).flat();

    expect(entries.length).toBeGreaterThan(0);
    expect(reports.filter((report) => !report.ok)).toEqual([]);
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
      expect(problems).toContain(`${id}.cases.yaml is missing; record a run with --record-cases, or write one, so CI tests the gates offline`);
      expect(problems.filter((problem) => !problem.includes("TODO(") && !problem.includes(".cases.yaml is missing"))).toEqual([]);
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

  it("refuses a write outside a mechanical step that follows an approved agent step", () => {
    const catalog = scratchCatalog();
    const file = new URL("marketing/market-research/market-research.stepfile.yaml", catalog);
    const document = parseYaml(readFileSync(file, "utf8")) as { tools: { tavily: { exposes: unknown[] } }; steps: Array<Record<string, unknown>> };
    document.tools.tavily.exposes = ["tavily_search"];
    writeFileSync(file, stringify(document));
    expect(entryProblems(catalog, "marketing", "market-research")).toContain(
      "step search calls tavily_search, which may write, from an agent step; a write belongs in a mechanical step after an agent step with an approve gate, or declare effect: read if it changes nothing",
    );

    const send = (query: unknown) => ({ id: "send", do: { calls: [{ id: "post", operation: "tavily_search", arguments: { query } }], output: {} }, produces: { type: "object" } });
    document.tools.tavily.exposes = [{ name: "tavily_search", effect: "read" }, "tavily_extract"];
    document.steps.push({ ...send({ var: "steps.report.summary" }), do: { calls: [{ id: "post", operation: "tavily_extract", arguments: { urls: [{ var: "steps.report.summary" }] } }], output: {} } });
    writeFileSync(file, stringify(document));
    expect(entryProblems(catalog, "marketing", "market-research")).toContain("step send writes with tavily_extract, but the agent step before it, report, has no approve gate");

    const report = document.steps.find((step) => step.id === "report") as { gates: unknown[] };
    report.gates.push({ id: "approved", approve: { message: "Send it?" } });
    (document.steps.at(-1) as { do: { calls: Array<{ arguments: unknown }> } }).do.calls = [
      { id: "first", operation: "tavily_search", arguments: { query: "x" } } as never,
      { id: "post", operation: "tavily_extract", arguments: { urls: [{ var: "responses.first.results" }] } } as never,
    ];
    writeFileSync(file, stringify(document));
    expect(entryProblems(catalog, "marketing", "market-research")).toContain("step send writes with tavily_extract from responses.first, but a write may use only inputs, settings and earlier steps' outputs, which the person approved");
  });

  it("requires a cases file beside every catalog stepfile", () => {
    const catalog = scratchCatalog();
    rmSync(new URL("marketing/market-research/market-research.cases.yaml", catalog));

    expect(entryProblems(catalog, "marketing", "market-research")).toContain("market-research.cases.yaml is missing; record a run with --record-cases, or write one, so CI tests the gates offline");
  });

  it("rejects an id used in two domains and a stepfile outside an entry folder", () => {
    const catalog = scratchCatalog();
    cpSync(new URL("marketing/market-research/", catalog), new URL("sales/market-research/", catalog), { recursive: true });
    mkdirSync(new URL("retail/", catalog));
    writeFileSync(new URL("retail/loose.stepfile.yaml", catalog), "stepgate: \"1\"\n");

    expect(catalogProblems(catalog)).toEqual([
      "awesome-stepfiles/retail/loose.stepfile.yaml must live in its own folder, awesome-stepfiles/retail/<id>/",
      "market-research appears in both marketing and sales; catalog names must be unique",
    ]);
  });
});
