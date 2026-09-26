// A plain MCP client that launches stepgate over stdio, answers its sampling requests with any
// OpenAI-compatible model, and calls the market-research stepfile. It only speaks MCP.
//
//   MODEL_BASE_URL=https://openrouter.ai/api/v1 MODEL_NAME=<model> MODEL_API_KEY=... \
//   TAVILY_API_KEY=... npm run demo
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

const client = new Client({ name: "stepgate-demo", version: "1.0.0" }, { capabilities: { sampling: { tools: {} } } });
client.setRequestHandler(CreateMessageRequestSchema, (request) => sample(request.params));

// The client's MCP configuration: the command to launch, and the environment it gets.
await client.connect(new StdioClientTransport({
  command: "node",
  args: ["src/cli.ts", "../examples/market-research.stepfile.yaml"],
  env: { ...getDefaultEnvironment(), TAVILY_API_KEY: required("TAVILY_API_KEY") },
}) as Transport);

const { tools } = await client.listTools();
console.log(`stepgate offers: ${tools.map((tool) => tool.name).join(", ")}`);

const result = await client.callTool({ name: "market-research", arguments: { brand: "Oatly", market: "UK plant-based milk" } }, undefined, {
  timeout: 120_000,
  resetTimeoutOnProgress: true,
  onprogress: (update) => console.log(`progress: ${update.message ?? ""}`),
});

if (result.isError === true) {
  console.log(`stepfile failed: ${JSON.stringify(result.content)}`);
} else {
  const outputs = (result.structuredContent as { outputs: { report?: { report?: string } } }).outputs;
  console.log(`\n${outputs.report?.report ?? JSON.stringify(outputs)}`);
}
await client.close();
