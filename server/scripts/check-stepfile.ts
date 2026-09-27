// Checks one catalog entry against the catalog rules, without running the whole test suite.
//
//   npm run check-stepfile -- <domain>/<id>
import { catalogDirectory, entryProblems } from "../src/catalog.ts";

const [domain, id, extra] = (process.argv[2] ?? "").split("/");
if (domain === undefined || id === undefined || id === "" || extra !== undefined) {
  console.error("usage: npm run check-stepfile -- <domain>/<id>");
  process.exit(2);
}

const problems = entryProblems(catalogDirectory(), domain, id);
if (problems.length > 0) {
  console.error(`${domain}/${id} breaks ${problems.length} rule(s):\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`${domain}/${id} follows the catalog rules`);
