// Checks that a release tag matches every place the version is written, before anything is published.
//
//   node scripts/check-release-version.ts v0.2.0
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.ts";

const tag = process.argv[2];
if (tag === undefined || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`usage: node scripts/check-release-version.ts vX.Y.Z (got ${tag ?? "nothing"})`);
  process.exit(2);
}

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as { version: string; packages?: Array<{ version: string }> };
const server = read("server.json");
const found: Record<string, string | undefined> = {
  "package.json version": read("package.json").version,
  "server.json version": server.version,
  "server.json packages[0].version": server.packages?.[0]?.version,
  "src/version.ts VERSION": VERSION,
};
const wrong = Object.entries(found).filter(([, version]) => `v${version}` !== tag);
if (wrong.length > 0) {
  console.error(`tag ${tag} does not match: ${wrong.map(([field, version]) => `${field} is ${version}`).join(", ")}`);
  process.exit(1);
}
console.log(`${tag} matches package.json, server.json and src/version.ts`);
