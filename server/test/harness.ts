import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateMessageRequestSchema, type CallToolResult, type CreateMessageRequest, type CreateMessageResultWithTools } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { SettingUnavailable } from "../src/engine/errors.ts";
import { load } from "../src/engine/load.ts";
import type { RunContext, JsonObject, LedgerRecord } from "../src/engine/types.ts";
import { createStepgateServer } from "../src/server.ts";
import { userAgent } from "../src/version.ts";
import { API_KEY, MCP_TOKEN, secretsFrom, startApi, startMcp, type Fixture } from "./fixtures.ts";

const BASE = readFileSync(new URL("fixtures/stock-check.stepfile.yaml", import.meta.url), "utf8");

export type SamplingContent = CreateMessageResultWithTools["content"];
export type Sampled = CreateMessageRequest["params"];

/** One scripted model turn that calls a tool. */
export function use(id: string, name: string, input: JsonObject): SamplingContent {
  return [{ type: "tool_use", id, name, input }];
}

export const GOOD_STOCK = use("s1", "submit", { name: "Blue kettle", count: 4, supplier: "Acme" });
export const GOOD_SUMMARY = use("s2", "submit", { summary: "Blue kettle has 4 in stock." });

export type Setup = {
  /** Changes the base stepfile before it is loaded. */
  edit?: (stepfile: JsonObject, addresses: { catalogue: string; checker: string; cataloguePort: string }) => void;
  turns: SamplingContent[];
  credentials?: Record<string, string>;
  settings?: (addresses: { cataloguePort: string }) => Record<string, string>;
  limits?: RunContext["limits"];
  flakyFailures?: number;
  sampling?: boolean;
};

export type Harness = {
  client: Client;
  call: (args: JsonObject) => Promise<CallToolResult>;
  sampled: Sampled[];
  records: LedgerRecord[];
  api: Fixture;
  mcp: Fixture;
  close: () => Promise<void>;
};

/** Starts the fixture servers and the Stepgate server, and connects a client whose sampling replays `turns`. */
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
  const server = createStepgateServer([load(JSON.stringify(stepfile))], {
    credentials: secretsFrom(setup.credentials ?? { catalogue: API_KEY, suppliers: MCP_TOKEN }),
    settings: async (name) => {
      const value = settings[name];
      if (value === undefined) {
        throw new SettingUnavailable(name, "not set in the test environment");
      }
      return value;
    },
    ledger: (_call, record) => void records.push(record),
    limits: setup.limits ?? { turnsPerStep: 8, toolResultChars: 10_000 },
    maxTokens: 4000,
    samplingTimeoutMs: 10_000,
    userAgent: userAgent(null),
  });
  const sampling = setup.sampling ?? true;
  const client = new Client({ name: "platform", version: "1.0.0" }, { capabilities: sampling ? { sampling: { tools: {} } } : {} });
  const sampled: Sampled[] = [];
  if (sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      sampled.push(structuredClone(request.params));
      const content = setup.turns[sampled.length - 1];
      if (content === undefined) {
        throw new Error(`no scripted sampling turn ${sampled.length}`);
      }
      return { role: "assistant", model: "scripted", stopReason: "toolUse", content };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide as Transport);
  await client.connect(clientSide as Transport);

  return {
    client,
    call: async (args) => (await client.callTool({ name: "stock-check", arguments: args })) as CallToolResult,
    sampled,
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
