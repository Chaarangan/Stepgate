// A plain agent that launches stepgate over stdio and runs one catalog stepfile with any OpenAI-compatible
// model, calling Stepgate's tools the way Claude or any other MCP client would. It only speaks MCP.
//
//   MODEL_BASE_URL=https://openrouter.ai/api/v1 MODEL_NAME=<model> MODEL_API_KEY=... \
//   npm run demo -- <catalog name> '<inputs as JSON>' [ledger directory]
//
// Credentials the stepfile needs (<NAME>_API_KEY) and STEPGATE_CONTACT are passed through, and
// STEPGATE_EXTRA_ARGS (space-separated) is added to stepgate's command line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const MAX_TURNS = 400;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`environment variable ${name} is required`);
  }
  return value;
}

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** One turn of the model, over the Chat Completions API. */
async function complete(messages: ChatMessage[], tools: unknown[]): Promise<{ content: string | null; tool_calls?: ChatToolCall[] }> {
  const model = required("MODEL_NAME");
  const response = await fetch(`${required("MODEL_BASE_URL")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${required("MODEL_API_KEY")}` },
    body: JSON.stringify({ model, messages, tools }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`chat completion with ${model} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  const message = (JSON.parse(text) as { choices: Array<{ message: { content: string | null; tool_calls?: ChatToolCall[] } }> }).choices[0]?.message;
  if (message === undefined) {
    throw new Error(`chat completion with ${model} returned no choices: ${text.slice(0, 500)}`);
  }
  return message;
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const [name, inputsJson, ledgerDir] = process.argv.slice(2);
if (name === undefined || inputsJson === undefined) {
  throw new Error("usage: npm run demo -- <catalog name> '<inputs as JSON>' [ledger directory]");
}

// Pass through only what stepgate needs: credentials (<NAME>_API_KEY, or the oauth2 refresh variables) and the operator contact.
const passThrough = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[1] !== undefined && /_(API_KEY|REFRESH_TOKEN|CLIENT_ID|CLIENT_SECRET)$/.test(entry[0]) && entry[0] !== "MODEL_API_KEY"));
const contact = process.env.STEPGATE_CONTACT;
const extraArgs = (process.env.STEPGATE_EXTRA_ARGS ?? "").split(" ").filter((arg) => arg !== "");

const client = new Client({ name: "stepgate-demo", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: ["src/cli.ts", ...(contact === undefined ? [] : ["--contact", contact]), ...(ledgerDir === undefined ? [] : ["--ledger-dir", ledgerDir]), ...extraArgs, name],
  env: { ...getDefaultEnvironment(), ...passThrough },
}) as Transport);

const { tools } = await client.listTools();
const chatTools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
const messages: ChatMessage[] = [
  { role: "system", content: client.getInstructions() ?? "" },
  { role: "user", content: `Run the ${name} stepfile with these inputs: ${inputsJson}` },
];

const started = Date.now();
let outcome: { state: string; outputs?: unknown; error?: string } | undefined;
for (let turn = 0; turn < MAX_TURNS && outcome === undefined; turn += 1) {
  const reply = await complete(messages, chatTools);
  messages.push({ role: "assistant", content: reply.content, ...(reply.tool_calls === undefined ? {} : { tool_calls: reply.tool_calls }) });
  const calls = reply.tool_calls ?? [];
  if (calls.length === 0) {
    messages.push({ role: "user", content: "Continue the run: use the Stepgate tools until it finishes." });
    continue;
  }
  for (const call of calls) {
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    const result = (await client.callTool({ name: call.function.name, arguments: args })) as CallToolResult;
    const state = result.structuredContent as { state?: string; step?: { step: string }; error?: string; outputs?: unknown } | undefined;
    console.log(`  ${call.function.name}${typeof args.operation === "string" ? ` ${args.operation}` : ""}: ${state?.step?.step === undefined ? state?.state ?? "?" : `step ${state.step.step}`}${result.isError === true ? " (error)" : ""}`);
    messages.push({ role: "tool", tool_call_id: call.id, content: textOf(result) });
    if (state?.state === "finished" || state?.state === "failed") {
      outcome = { state: state.state, outputs: state.outputs, ...(state.error === undefined ? {} : { error: textOf(result) }) };
    }
  }
}

console.log(`\n${name} finished in ${Math.round((Date.now() - started) / 1000)}s`);
if (outcome?.state === "finished") {
  console.log(JSON.stringify(outcome.outputs, null, 2));
} else {
  console.log(`FAILED: ${outcome?.error ?? `the model stopped after ${MAX_TURNS} turns without finishing`}`);
  process.exitCode = 1;
}
await client.close();
