#!/usr/bin/env node
// Serves stepfiles as MCP tools; the client's own agent does each step and Stepgate gates it.
//
//   stepgate [--http <port>] [--ledger-dir <dir>] [<stepfile.yaml | catalog name>...]
//
// An argument ending in .yaml, .yml or .json is a file; anything else names a stepfile in the
// bundled catalog. Without --http it speaks stdio, which is how desktop MCP clients launch servers. Credential
// <name> is read from <NAME>_API_KEY, or refreshed from <NAME>_REFRESH_TOKEN for oauth2 (src/operator.ts). Budgets default as shown in --help.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isPublicHttpsUrl } from "./engine/http.ts";
import { oneLine } from "./engine/tools/tool.ts";
import { directorySink, firstBreak, streamSink } from "./engine/ledger.ts";
import { load } from "./engine/load.ts";
import { catalogDirectory, catalogFile, listCatalog } from "./catalog.ts";
import { parseCases, testGates } from "./gate-test.ts";
import { serveHttp } from "./http-server.ts";
import { environmentCredentials, environmentSettings } from "./operator.ts";
import { authorizeCredential } from "./authorize.ts";
import { directoryCaseSink } from "./record-cases.ts";
import { fixedStepfiles, watchStepfiles } from "./served.ts";
import { createStepgateServer, type StepgateServerOptions } from "./server.ts";
import { userAgent } from "./version.ts";
import type { LedgerRecord } from "./engine/types.ts";

const HELP = `usage: stepgate [options] [<stepfile.yaml | catalog name>...]
       stepgate --list
       stepgate --verify <ledger.jsonl>...
       stepgate --test <stepfile.yaml | catalog name> [<cases.yaml>]
       stepgate --auth <stepfile.yaml | catalog name> <credential> [--client-id <id>]

With no stepfiles it serves only the tools for writing new ones.

  --list                     show the stepfiles in the bundled catalog
  --verify                   check that each ledger file's hash chain is intact; exits 1 if one is broken
  --test                     run a stepfile's gates over recorded cases, offline; the cases default to <id>.cases.yaml beside it
  --auth                     authorize an oauth2 credential with its MCP server's authorization server, and print what to set
  --client-id <id>           with --auth, a client registered for http://127.0.0.1 redirects, where the server offers no registration
  --contact <email>          your contact email, sent in the User-Agent (SEC EDGAR and USAJOBS require one)
  --http <port>              serve Streamable HTTP on 127.0.0.1:<port>/mcp instead of stdio
  --ledger-dir <dir>         write one ledger file per run there; otherwise records go to stderr
  --calls-per-step <n>       most tool calls one step may make (100)
  --tool-result-chars <n>    longest tool result passed to the client (20000)
  --run-idle-ms <n>          how long a run waits for the client's next call before it is abandoned (1800000)
  --request-timeout-ms <n>   how long one outgoing request may take, body included (60000)
  --response-bytes <n>       largest response Stepgate reads from an API (10485760)
  --draft-credential <name>=<host>[,<host>...]
                             let drafts use credential <name>, sent only to these hosts; repeatable
  --draft-setting <name>     let drafts use setting <name> from the environment; repeatable
  --record-cases <dir>       write each finished or failed run there as a cases file for --test; it holds the APIs' full responses
  --watch                    reload a stepfile when its file changes; runs in progress keep the version they started with`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    http: { type: "string" },
    "ledger-dir": { type: "string" },
    "calls-per-step": { type: "string", default: "100" },
    "tool-result-chars": { type: "string", default: "20000" },
    "run-idle-ms": { type: "string", default: "1800000" },
    "request-timeout-ms": { type: "string", default: "60000" },
    "response-bytes": { type: "string", default: "10485760" },
    help: { type: "boolean" },
    list: { type: "boolean" },
    verify: { type: "boolean" },
    test: { type: "boolean" },
    contact: { type: "string" },
    "draft-credential": { type: "string", multiple: true },
    "draft-setting": { type: "string", multiple: true },
    watch: { type: "boolean" },
    auth: { type: "boolean" },
    "client-id": { type: "string" },
    "record-cases": { type: "string" },
  },
});

if (values.list === true) {
  let domain: string | undefined;
  for (const entry of listCatalog(catalogDirectory())) {
    if (entry.domain !== domain) {
      console.log(`${domain === undefined ? "" : "\n"}${entry.domain}`);
      domain = entry.domain;
    }
    const summary = oneLine(entry.stepfile.document.description ?? entry.stepfile.document.title ?? "");
    console.log(`  ${entry.id}: ${summary}`);
  }
  process.exit(0);
}

if (values.verify === true) {
  let broken = false;
  for (const file of positionals) {
    const records = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as LedgerRecord);
    const found = firstBreak(records);
    broken ||= found !== null;
    console.log(found === null ? `${file}: intact, ${records.length} records` : `${file}: broken at seq ${found.seq}: ${found.reason}`);
  }
  process.exit(broken ? 1 : 0);
}

if (values.auth === true) {
  const [target, credential] = positionals;
  if (target === undefined || credential === undefined) {
    throw new Error("--auth needs a stepfile path or catalog name and a credential name");
  }
  const stepfile = load(readFileSync(stepfilePath(target), "utf8"));
  const variables = await authorizeCredential(stepfile, credential, values["client-id"] ?? null, { userAgent: userAgent(contactEmail(values.contact)) }, environmentSettings(process.env), async (url) => {
    console.error(`stepgate: open this URL in a browser and approve access for ${credential}:\n\n  ${url.href}\n`);
  });
  console.error("stepgate: authorized. Set these in the server's environment, and keep them secret:");
  for (const [name, value] of Object.entries(variables)) {
    console.log(`${name}=${value}`);
  }
  process.exit(0);
}

if (values.test === true) {
  const [target, casesArgument] = positionals;
  if (target === undefined) {
    throw new Error("--test needs a stepfile path or catalog name");
  }
  const file = stepfilePath(target);
  const stepfile = load(readFileSync(file, "utf8"));
  const casesFile = casesArgument ?? new URL(`${stepfile.document.id}.cases.yaml`, typeof file === "string" ? pathToFileURL(file) : file);
  const reports = await testGates(stepfile, parseCases(stepfile, readFileSync(casesFile, "utf8")));
  for (const report of reports) {
    const skipped = report.skipped.length === 0 ? "" : ` (verifier and approve gates not run offline: ${report.skipped.join(", ")})`;
    console.log(`${report.ok ? "ok" : "FAIL"}  ${report.case} / ${report.step}${skipped}${report.problem === null ? "" : `\n      ${report.problem}`}`);
    for (const failure of report.ok ? [] : report.failed) {
      console.log(`      ${failure.gate}: ${failure.diagnosis ?? ""}`);
    }
  }
  process.exit(reports.every((report) => report.ok) ? 0 : 1);
}

if (values.help === true) {
  console.error(HELP);
  process.exit(0);
}

function contactEmail(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (!/^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/.test(value)) {
    throw new Error(`--contact must be an email address, got ${value}`);
  }
  return value;
}

function positiveInteger(flag: string, text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive integer, got ${text}`);
  }
  return value;
}

/** `--draft-credential jira=acme.atlassian.net,api.atlassian.com`: the credential and the only hosts a draft may send it to. */
function draftCredential(grant: string): [string, string[]] {
  const [name, hosts] = grant.split("=", 2);
  if (name === undefined || name === "" || hosts === undefined || hosts === "") {
    throw new Error(`--draft-credential must be <name>=<host>[,<host>...], got ${grant}`);
  }
  return [name, hosts.split(",").map((host) => host.trim().toLowerCase())];
}

function stepfilePath(argument: string): URL | string {
  return /\.(ya?ml|json)$/i.test(argument) ? argument : catalogFile(catalogDirectory(), argument);
}

// Loading every file first means a bad stepfile stops the server at start, not at first call; --watch then reloads edits.
const stepfiles = values.watch === true
  ? watchStepfiles(positionals.map(stepfilePath))
  : fixedStepfiles(positionals.map((argument) => load(readFileSync(stepfilePath(argument), "utf8"))));
const ledgerDir = values["ledger-dir"];

const limits = {
  callsPerStep: positiveInteger("calls-per-step", values["calls-per-step"]),
  toolResultChars: positiveInteger("tool-result-chars", values["tool-result-chars"]),
  requestTimeoutMs: positiveInteger("request-timeout-ms", values["request-timeout-ms"]),
  responseBytes: positiveInteger("response-bytes", values["response-bytes"]),
};
const agent = userAgent(contactEmail(values.contact));

const options: StepgateServerOptions = {
  credentials: environmentCredentials(process.env, { userAgent: agent, limits }),
  settings: environmentSettings(process.env),
  ledger: ledgerDir === undefined ? streamSink(process.stderr) : directorySink(ledgerDir),
  recordCases: values["record-cases"] === undefined ? null : directoryCaseSink(values["record-cases"]),
  limits,
  runIdleMs: positiveInteger("run-idle-ms", values["run-idle-ms"]),
  userAgent: agent,
  drafts: {
    urlAllowed: isPublicHttpsUrl,
    credentials: new Map((values["draft-credential"] ?? []).map(draftCredential)),
    settings: new Set(values["draft-setting"] ?? []),
  },
};

function served(): string {
  const ids = stepfiles.entries().map((entry) => entry.id);
  return `${ids.length === 0 ? "the authoring tools only" : ids.join(", ")}${values.watch === true ? ", reloading edited files" : ""}`;
}

if (values["record-cases"] !== undefined) {
  console.error(`stepgate: recording cases in ${values["record-cases"]}; each file holds the APIs' full responses, so trim them before sharing`);
}

if (values.http === undefined) {
  // The MCP SDK's own types disagree under exactOptionalPropertyTypes; the runtime object is a Transport.
  await createStepgateServer(stepfiles, options).connect(new StdioServerTransport() as Transport);
  console.error(`stepgate: serving ${served()} over stdio`);
} else {
  const { port } = await serveHttp(stepfiles, options, positiveInteger("http", values.http));
  console.error(`stepgate: serving ${served()} at http://127.0.0.1:${port}/mcp`);
}
