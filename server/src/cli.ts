#!/usr/bin/env node
// Serves stepfiles as MCP tools that run on the client's model through sampling.
//
//   stepgate [--http <port>] [--ledger-dir <dir>] <stepfile.yaml | catalog name>...
//
// An argument ending in .yaml, .yml or .json is a file; anything else names a stepfile in the
// bundled catalog. Without --http it speaks stdio, which is how desktop MCP clients launch servers. Credential
// <name> is read from the environment variable <NAME>_API_KEY. Budgets default as shown in --help.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CredentialUnavailable, SettingUnavailable } from "./engine/errors.ts";
import { settingVariable } from "./engine/settings.ts";
import { load } from "./engine/load.ts";
import { catalogDirectory, catalogFile, listCatalog } from "./catalog.ts";
import { createStepgateServer, type StepgateServerOptions } from "./server.ts";
import { userAgent } from "./version.ts";
import type { LedgerRecord } from "./engine/types.ts";

const HELP = `usage: stepgate [options] <stepfile.yaml | catalog name>...
       stepgate --list

  --list                     show the stepfiles in the bundled catalog
  --contact <email>          your contact email, sent in the User-Agent (SEC EDGAR and USAJOBS require one)
  --http <port>              serve Streamable HTTP on 127.0.0.1:<port>/mcp instead of stdio
  --ledger-dir <dir>         write one ledger file per run there; otherwise records go to stderr
  --turns-per-step <n>       most model turns one step may take (30)
  --tool-result-chars <n>    longest tool result passed to the model (20000)
  --max-tokens <n>           maxTokens on each sampling request (16000)
  --sampling-timeout-ms <n>  how long one sampling request may take (600000)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    http: { type: "string" },
    "ledger-dir": { type: "string" },
    "turns-per-step": { type: "string", default: "30" },
    "tool-result-chars": { type: "string", default: "20000" },
    "max-tokens": { type: "string", default: "16000" },
    "sampling-timeout-ms": { type: "string", default: "600000" },
    help: { type: "boolean" },
    list: { type: "boolean" },
    contact: { type: "string" },
  },
});

if (values.list === true) {
  let domain: string | undefined;
  for (const entry of listCatalog(catalogDirectory())) {
    if (entry.domain !== domain) {
      console.log(`${domain === undefined ? "" : "\n"}${entry.domain}`);
      domain = entry.domain;
    }
    const summary = (entry.stepfile.document.description ?? entry.stepfile.document.title ?? "").replace(/\s+/g, " ").trim();
    console.log(`  ${entry.id}: ${summary}`);
  }
  process.exit(0);
}

if (values.help === true || positionals.length === 0) {
  console.error(HELP);
  process.exit(values.help === true ? 0 : 2);
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

function stepfilePath(argument: string): URL | string {
  return /\.(ya?ml|json)$/i.test(argument) ? argument : catalogFile(catalogDirectory(), argument);
}

// Loading every file first means a bad stepfile stops the server at start, not at first call.
const stepfiles = positionals.map((argument) => load(readFileSync(stepfilePath(argument), "utf8")));
const ledgerDir = values["ledger-dir"];
if (ledgerDir !== undefined) {
  mkdirSync(ledgerDir, { recursive: true });
}

const options: StepgateServerOptions = {
  credentials: async (name) => {
    const variable = `${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
    const value = process.env[variable];
    if (value === undefined || value === "") {
      throw new CredentialUnavailable(name, `set ${variable} in the server's environment`);
    }
    return value;
  },
  settings: async (name) => {
    const variable = settingVariable(name);
    const value = process.env[variable];
    if (value === undefined || value === "") {
      throw new SettingUnavailable(name, `set ${variable} in the server's environment`);
    }
    return value;
  },
  ledger: (call: { stepfile: string; call: string }, record: LedgerRecord) => {
    const line = `${JSON.stringify({ stepfile: call.stepfile, ...record })}\n`;
    if (ledgerDir === undefined) {
      process.stderr.write(line);
    } else {
      appendFileSync(join(ledgerDir, `${call.stepfile}-${call.call}.jsonl`), line);
    }
  },
  limits: {
    turnsPerStep: positiveInteger("turns-per-step", values["turns-per-step"]),
    toolResultChars: positiveInteger("tool-result-chars", values["tool-result-chars"]),
  },
  maxTokens: positiveInteger("max-tokens", values["max-tokens"]),
  samplingTimeoutMs: positiveInteger("sampling-timeout-ms", values["sampling-timeout-ms"]),
  userAgent: userAgent(contactEmail(values.contact)),
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

if (values.http === undefined) {
  // The MCP SDK's own types disagree under exactOptionalPropertyTypes; the runtime object is a Transport.
  await createStepgateServer(stepfiles, options).connect(new StdioServerTransport() as Transport);
  console.error(`stepgate: serving ${stepfiles.map((stepfile) => stepfile.document.id).join(", ")} over stdio`);
} else {
  const port = positiveInteger("http", values.http);
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const body = request.method === "POST" ? await readJson(request) : undefined;
    const sessionId = request.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      await existing.handleRequest(request, response, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session; start with initialize" }));
      return;
    }
    // Stateful sessions, because sampling sends requests from server to client mid-call.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => void sessions.set(id, transport),
      onsessionclosed: (id) => void sessions.delete(id),
    });
    await createStepgateServer(stepfiles, options).connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  }).listen(port, "127.0.0.1", () => {
    console.error(`stepgate: serving ${stepfiles.map((stepfile) => stepfile.document.id).join(", ")} at http://127.0.0.1:${port}/mcp`);
  });
}
