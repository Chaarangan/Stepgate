import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { DraftPolicy } from "../src/authoring.ts";
import { SettingUnavailable } from "../src/engine/errors.ts";
import { isLoopbackHttpUrl, isPublicHttpsUrl } from "../src/engine/http.ts";
import { load } from "../src/engine/load.ts";
import type { CredentialSource, RunContext, JsonObject, LedgerRecord } from "../src/engine/types.ts";
import { fixedStepfiles } from "../src/served.ts";
import { createStepgateServer } from "../src/server.ts";
import { userAgent } from "../src/version.ts";
import { API_KEY, MCP_TOKEN, secretsFrom, startApi, startMcp, type Fixture } from "./fixtures.ts";

const BASE = readFileSync(new URL("fixtures/stock-check.stepfile.yaml", import.meta.url), "utf8");

export const loopbackOrPublic = (url: string): boolean => isPublicHttpsUrl(url) || isLoopbackHttpUrl(url);

/** One scripted client action: a call to one of the step's operations, or a submission. */
export type Action = { operation: string; arguments: JsonObject } | { submit: JsonObject };

export function use(operation: string, args: JsonObject): Action {
  return { operation, arguments: args };
}

export function submit(output: JsonObject): Action {
  return { submit: output };
}

export const GOOD_STOCK = submit({ name: "Blue kettle", count: 4, supplier: "Acme" });
export const GOOD_SUMMARY = submit({ summary: "Blue kettle has 4 in stock." });

/** What a run response carries in structuredContent. */
export type RunState = { run: string | null; state: "running" | "finished" | "failed"; step?: { step: string; instructions: string; operations: Array<{ name: string; inputSchema: JsonObject }> } } & JsonObject;

export type Setup = {
  /** Changes the base stepfile before it is loaded. */
  edit?: (stepfile: JsonObject, addresses: { catalogue: string; checker: string; cataloguePort: string }) => void;
  /** What the client does after starting the run, in order, until the run finishes or fails. */
  actions: Action[];
  credentials?: Record<string, string>;
  /** How the person answers each approve gate, in order; when absent the client declares no elicitation support. */
  approvals?: Array<{ action: "accept" | "decline" | "cancel"; reason?: string }>;
  /** Replaces `credentials` with a real source, such as the operator's environment adapter. */
  credentialSource?: CredentialSource;
  settings?: (addresses: { cataloguePort: string }) => Record<string, string>;
  limits?: Partial<RunContext["limits"]>;
  flakyFailures?: number;
  runIdleMs?: number;
  /** Defaults to letting drafts reach the loopback fixture servers as well as public https, with no credentials or settings. */
  drafts?: (addresses: { catalogueHost: string }) => DraftPolicy;
};

export type Harness = {
  client: Client;
  /** Starts a run with these inputs, plays the actions, and returns the last response. */
  call: (args: JsonObject) => Promise<CallToolResult>;
  /** The message of every approval the client was asked for. */
  asked: string[];
  /** Every response the client received, starting with the run's first step. */
  seen: CallToolResult[];
  records: LedgerRecord[];
  api: Fixture;
  mcp: Fixture;
  close: () => Promise<void>;
};

/** Starts the fixture servers and the Stepgate server, and connects a client that plays `actions` on each run. */
export async function startHarness(setup: Setup): Promise<Harness> {
  const api = await startApi(setup.flakyFailures ?? 0);
  const mcp = await startMcp();
  const text = BASE.replaceAll("${catalogue.origin}", api.origin).replaceAll("${catalogue.host}", api.host)
    .replaceAll("${suppliers.origin}", mcp.origin).replaceAll("${suppliers.host}", mcp.host);
  const stepfile = parseYaml(text) as JsonObject;
  const cataloguePort = api.host.split(":")[1] ?? "";
  setup.edit?.(stepfile, { catalogue: api.origin, checker: `${api.origin}/verify`, cataloguePort });
  const settings = setup.settings?.({ cataloguePort }) ?? {};

  const records: LedgerRecord[] = [];
  const server = createStepgateServer(fixedStepfiles([load(JSON.stringify(stepfile))]), {
    credentials: setup.credentialSource ?? secretsFrom(setup.credentials ?? { catalogue: API_KEY, suppliers: MCP_TOKEN }),
    settings: async (name) => {
      const value = settings[name];
      if (value === undefined) {
        throw new SettingUnavailable(name, "not set in the test environment");
      }
      return value;
    },
    ledger: (record) => void records.push(record),
    limits: { callsPerStep: 8, toolResultChars: 10_000, requestTimeoutMs: 5_000, responseBytes: 1_000_000, ...setup.limits },
    runIdleMs: setup.runIdleMs ?? 60_000,
    userAgent: userAgent(null),
    drafts: setup.drafts?.({ catalogueHost: api.host }) ?? { urlAllowed: loopbackOrPublic, credentials: new Map(), settings: new Set() },
  });
  const client = new Client({ name: "platform", version: "1.0.0" }, { capabilities: setup.approvals === undefined ? {} : { elicitation: { form: {} } } });
  const answers = [...(setup.approvals ?? [])];
  const asked: string[] = [];
  if (setup.approvals !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error("the test scripted no more approval answers");
      }
      return answer.reason === undefined ? { action: answer.action } : { action: answer.action, content: { reason: answer.reason } };
    });
  }
  const seen: CallToolResult[] = [];
  const respond = async (name: string, args: JsonObject) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    seen.push(result);
    return result;
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide as Transport);
  await client.connect(clientSide as Transport);

  return {
    client,
    call: async (args) => {
      let result = await respond("stock-check", args);
      const { run } = stateOf(result);
      for (const action of setup.actions) {
        if (stateOf(result).state !== "running") {
          break;
        }
        result = "submit" in action
          ? await respond("stepgate_submit", { run, output: action.submit })
          : await respond("stepgate_call", { run, operation: action.operation, arguments: action.arguments });
      }
      return result;
    },
    seen,
    asked,
    records,
    api,
    mcp,
    close: async () => {
      await client.close();
      await api.close();
      await mcp.close();
    },
  };
}

/** The text of a tool result, for asserting on error messages. */
export function resultText(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function stateOf(result: CallToolResult | undefined): RunState {
  return result?.structuredContent as RunState;
}

/** The step views the client was shown, in order. */
export function stepViews(seen: CallToolResult[]): NonNullable<RunState["step"]>[] {
  return seen.flatMap((result) => stateOf(result).step ?? []);
}
