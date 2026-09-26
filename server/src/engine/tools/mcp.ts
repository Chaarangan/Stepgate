import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PreflightFailed, StepgateError, ToolCallFailed } from "../errors.ts";
import { guardedFetch, type CredentialBinding, type HttpContext } from "../http.ts";
import { canonicalHash } from "../identity.ts";
import type { JsonObject, ToolDeclaration, ToolDefinition } from "../types.ts";
import type { ToolResult } from "./tool-result.ts";

export type McpTool = {
  definitions: ToolDefinition[];
  call: (name: string, args: JsonObject) => Promise<ToolResult>;
  close: () => Promise<void>;
};

function bearer(secret: string, headers: Headers): void {
  headers.set("Authorization", `Bearer ${secret}`);
}

function describeContent(result: Record<string, unknown>): string {
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .map((part: { type?: unknown; text?: unknown }) => (part.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part)))
    .join("\n");
}

/** Connects to a remote MCP server, checks every exposed tool, and returns them. */
export async function prepareMcpTool(
  context: HttpContext,
  toolName: string,
  declaration: ToolDeclaration,
  credential: Omit<CredentialBinding, "place"> | null,
): Promise<McpTool> {
  const url = declaration.mcp?.url;
  if (url === undefined) {
    throw new TypeError(`tool ${toolName} is not an mcp tool`);
  }
  const binding = credential === null ? null : { ...credential, place: bearer };
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => guardedFetch(context, `mcp ${toolName}`, new URL(input), init ?? {}, binding),
  });
  const client = new Client({ name: "stepgate", version: "0.0.0" });
  try {
    // The MCP SDK's own types disagree under exactOptionalPropertyTypes; the runtime object is a Transport.
    await client.connect(transport as Transport);
  } catch (error) {
    if (error instanceof StepgateError) {
      throw error;
    }
    throw new PreflightFailed(`tool ${toolName}`, `could not connect to ${url}: ${(error as Error).message}`, { cause: error });
  }

  const listed = await client.listTools();
  const available = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const definitions = (declaration.exposes ?? []).map((entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const tool = available.get(name);
    if (tool === undefined) {
      throw new PreflightFailed(`tool ${toolName}`, `server does not offer ${name}; it offers ${[...available.keys()].join(", ")}`);
    }
    const inputSchema = tool.inputSchema as JsonObject;
    if (typeof entry !== "string" && canonicalHash(inputSchema) !== entry.schema_sha256) {
      throw new PreflightFailed(`tool ${toolName}`, `${name} input schema is ${canonicalHash(inputSchema)}, expected ${entry.schema_sha256}`);
    }
    return { name, description: tool.description ?? name, inputSchema };
  });

  return {
    definitions,
    call: async (name, args) => {
      try {
        const result = await client.callTool({ name, arguments: args });
        return { content: describeContent(result), isError: result.isError === true, status: null };
      } catch (error) {
        if (error instanceof StepgateError) {
          throw error;
        }
        throw new ToolCallFailed(`mcp ${toolName}.${name}`, null, (error as Error).message, { cause: error });
      }
    },
    close: () => client.close(),
  };
}
