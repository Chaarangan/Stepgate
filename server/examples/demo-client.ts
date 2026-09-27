// A plain MCP client that launches stepgate over stdio, answers its sampling requests with any
// OpenAI-compatible model, and calls one catalog stepfile. It only speaks MCP.
//
//   MODEL_BASE_URL=https://openrouter.ai/api/v1 MODEL_NAME=<model> MODEL_API_KEY=... \
//   npm run demo -- <catalog name> '<inputs as JSON>' [ledger directory]
//
// Credentials the stepfile needs (<NAME>_API_KEY) and STEPGATE_CONTACT are passed through, and
// STEPGATE_EXTRA_ARGS (space-separated) is added to stepgate's command line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateMessageRequestSchema, type CreateMessageRequest, type CreateMessageResultWithTools } from "@modelcontextprotocol/sdk/types.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`environment variable ${name} is required`);
  }
  return value;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; toolUseId?: string; content?: Block[]; isError?: boolean };

/** MCP sampling messages as Chat Completions messages: tool results become `role: "tool"` messages. */
function toChat(params: CreateMessageRequest["params"]): unknown[] {
  const chat: unknown[] = params.systemPrompt === undefined ? [] : [{ role: "system", content: params.systemPrompt }];
  for (const message of params.messages) {
    const blocks = (Array.isArray(message.content) ? message.content : [message.content]) as Block[];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    if (message.role === "assistant") {
      const calls = blocks.filter((block) => block.type === "tool_use");
      chat.push({
        role: "assistant",
        content: text || null,
        ...(calls.length === 0 ? {} : { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) }),
      });
    } else if (blocks.some((block) => block.type === "tool_result")) {
      for (const result of blocks.filter((block) => block.type === "tool_result")) {
        const body = (result.content ?? []).map((part) => part.text ?? "").join("");
        chat.push({ role: "tool", tool_call_id: result.toolUseId, content: result.isError === true ? `Error: ${body}` : body });
      }
    } else {
      chat.push({ role: "user", content: text });
    }
  }
  return chat;
}

/** The client's own model, answering one sampling request. */
async function sample(params: CreateMessageRequest["params"]): Promise<CreateMessageResultWithTools> {
  const model = required("MODEL_NAME");
  const response = await fetch(`${required("MODEL_BASE_URL")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${required("MODEL_API_KEY")}` },
    body: JSON.stringify({
      model,
      max_tokens: params.maxTokens,
      messages: toChat(params),
      tools: (params.tools ?? []).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`chat completion with ${model} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  const message = (JSON.parse(text) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }).choices[0]?.message;
  const calls = message?.tool_calls ?? [];
  console.log(`  sampled: ${calls.length === 0 ? "text reply" : calls.map((call) => call.function.name).join(", ")}`);
  const content = [
    ...(message?.content ? [{ type: "text" as const, text: message.content }] : []),
    ...calls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as Record<string, unknown> })),
  ];
  return { role: "assistant", model, stopReason: calls.length > 0 ? "toolUse" : "endTurn", content };
}

const [name, inputsJson, ledgerDir] = process.argv.slice(2);
if (name === undefined || inputsJson === undefined) {
  throw new Error("usage: npm run demo -- <catalog name> '<inputs as JSON>' [ledger directory]");
}

// Pass through only what stepgate needs: credentials (<NAME>_API_KEY) and the operator contact.
const passThrough = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[1] !== undefined && entry[0].endsWith("_API_KEY") && entry[0] !== "MODEL_API_KEY"));
const contact = process.env.STEPGATE_CONTACT;
const extraArgs = (process.env.STEPGATE_EXTRA_ARGS ?? "").split(" ").filter((arg) => arg !== "");

const client = new Client({ name: "stepgate-demo", version: "1.0.0" }, { capabilities: { sampling: { tools: {} } } });
client.setRequestHandler(CreateMessageRequestSchema, (request) => sample(request.params));

// The client's MCP configuration: the command to launch, and the environment it gets.
await client.connect(new StdioClientTransport({
  command: "node",
  args: ["src/cli.ts", ...(contact === undefined ? [] : ["--contact", contact]), ...(ledgerDir === undefined ? [] : ["--ledger-dir", ledgerDir]), ...extraArgs, name],
  env: { ...getDefaultEnvironment(), ...passThrough },
}) as Transport);

const started = Date.now();
const result = await client.callTool({ name, arguments: JSON.parse(inputsJson) as Record<string, unknown> }, undefined, {
  timeout: 120_000,
  resetTimeoutOnProgress: true,
  onprogress: (update) => console.log(`progress: ${update.message ?? ""}`),
});

console.log(`\n${name} finished in ${Math.round((Date.now() - started) / 1000)}s`);
if (result.isError === true) {
  console.log(`FAILED: ${JSON.stringify(result.content)}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify((result.structuredContent as { outputs: unknown }).outputs, null, 2));
}
await client.close();
