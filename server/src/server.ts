import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type CreateMessageRequestParamsWithTools,
  type SamplingMessage,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { randomUUID } from "node:crypto";
import { StepgateError } from "./engine/errors.ts";
import { run } from "./engine/run.ts";
import type { RunContext, JsonObject, LedgerRecord, Message, ModelReply, ModelRequest, Stepfile } from "./engine/types.ts";

export type StepgateServerOptions = {
  credentials: RunContext["credentials"];
  /** Receives every ledger record, tagged with the stepfile and the tool call it belongs to. */
  ledger: (call: { stepfile: string; call: string }, record: LedgerRecord) => void | Promise<void>;
  limits: RunContext["limits"];
  /** Passed to the client as `maxTokens` on every sampling request. */
  maxTokens: number;
  /** How long one sampling request may take before it fails, in milliseconds. */
  samplingTimeoutMs: number;
};

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The engine's messages as MCP sampling messages. Consecutive tool results share one user message, as the spec requires. */
function toSamplingMessages(messages: Message[]): SamplingMessage[] {
  const converted: SamplingMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: { type: "text", text: message.text } });
    } else if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: [
          ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
          ...message.toolCalls.map((call) => ({
            type: "tool_use" as const,
            id: call.id,
            name: call.name,
            input: (call.arguments !== null && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {}) as Record<string, unknown>,
          })),
        ],
      });
    } else {
      const result = { type: "tool_result" as const, toolUseId: message.toolCallId, content: [{ type: "text" as const, text: message.content }], isError: message.isError };
      const previous = converted.at(-1);
      if (previous !== undefined && previous.role === "user" && Array.isArray(previous.content) && previous.content.every((part) => part.type === "tool_result")) {
        previous.content.push(result);
      } else {
        converted.push({ role: "user", content: [result] });
      }
    }
  }
  return converted;
}

function toReply(content: unknown): ModelReply {
  const blocks = (Array.isArray(content) ? content : [content]) as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  return {
    text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
    toolCalls: blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id ?? "", name: block.name ?? "", arguments: block.input })),
  };
}

function samplingModel(server: Server, extra: Extra, options: StepgateServerOptions): RunContext["model"] {
  return async (request: ModelRequest) => {
    const params: CreateMessageRequestParamsWithTools = {
      systemPrompt: request.system,
      messages: toSamplingMessages(request.messages),
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as { type: "object" } })),
      toolChoice: { mode: "auto" },
      maxTokens: options.maxTokens,
    };
    const result = await server.createMessage(params, { relatedRequestId: extra.requestId, timeout: options.samplingTimeoutMs });
    return toReply(result.content);
  };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * An MCP server exposing each stepfile as a tool. Steps run on the calling client's own model
 * through sampling, so a client installs nothing to run a stepfile.
 */
export function createStepgateServer(stepfiles: Stepfile[], options: StepgateServerOptions): Server {
  const byId = new Map(stepfiles.map((stepfile) => [stepfile.document.id, stepfile]));
  const server = new Server({ name: "stepgate", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: stepfiles.map(({ document }) => ({
      name: document.id,
      ...(document.title === undefined ? {} : { title: document.title }),
      description: document.description ?? document.title ?? `Runs the ${document.id} stepfile.`,
      inputSchema: document.inputs as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const stepfile = byId.get(request.params.name);
    if (stepfile === undefined) {
      return failure(`no stepfile named ${request.params.name}`);
    }
    if (server.getClientCapabilities()?.sampling?.tools === undefined) {
      return failure("this client does not declare sampling with tools (capability sampling.tools), which stepfiles need to use its model");
    }
    const progressToken = extra._meta?.progressToken;
    const call = { stepfile: stepfile.document.id, call: randomUUID() };
    const runContext: RunContext = {
      model: samplingModel(server, extra, options),
      credentials: options.credentials,
      limits: options.limits,
      ledger: async (record) => {
        await options.ledger(call, record);
        if (progressToken !== undefined) {
          const step = typeof record.step === "string" ? ` ${record.step}` : "";
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: record.seq + 1, message: `${record.type}${step}` } });
        }
      },
    };
    try {
      const result = await run(stepfile, (request.params.arguments ?? {}) as JsonObject, runContext);
      return { content: [{ type: "text", text: JSON.stringify(result.outputs) }], structuredContent: { identity: result.identity, outputs: result.outputs } };
    } catch (error) {
      if (error instanceof StepgateError) {
        return failure(`${error.name}: ${error.message}`);
      }
      throw error;
    }
  });

  return server;
}
