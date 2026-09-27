import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PreflightFailed, StepgateError, ToolCallFailed } from "../errors.ts";
import { guardedFetch, type CredentialBinding, type HttpContext } from "../http.ts";
import { canonicalHash } from "../identity.ts";
import { VERSION } from "../../version.ts";
import type { JsonObject, ToolDeclaration } from "../types.ts";
import { matchesSearch, oneLine, type InspectRequest, type PreparedTool, type ToolKind } from "./tool.ts";

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

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

/**
 * Connects and lists the server's tools, every request going through guardedFetch. The client is closed on any
 * failure; on success the caller owns it. A failure that is not already a StepgateError raises what `fail` builds.
 */
async function connect(
  context: HttpContext,
  operation: string,
  url: URL,
  binding: CredentialBinding | null,
  fail: (message: string, cause: unknown) => StepgateError,
): Promise<{ client: Client; tools: Listed }> {
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: (input, init) => guardedFetch(context, operation, new URL(input), init ?? {}, binding),
  });
  const client = new Client({ name: "stepgate", version: VERSION });
  try {
    // The MCP SDK's own types disagree under exactOptionalPropertyTypes; the runtime object is a Transport.
    await client.connect(transport as Transport);
    const { tools } = await client.listTools();
    return { client, tools };
  } catch (error) {
    await client.close();
    if (error instanceof StepgateError) {
      throw error;
    }
    throw fail((error as Error).message, error);
  }
}

/** Connects to a remote MCP server, checks every exposed tool, and returns them. */
async function prepareMcpTool(
  context: HttpContext,
  toolName: string,
  declaration: ToolDeclaration,
  credential: Omit<CredentialBinding, "place"> | null,
): Promise<PreparedTool> {
  const url = declaration.mcp?.url;
  if (url === undefined) {
    throw new TypeError(`tool ${toolName} is not an mcp tool`);
  }
  const binding = credential === null ? null : { ...credential, place: bearer };
  const { client, tools } = await connect(context, `mcp ${toolName}`, new URL(url), binding, (message, cause) =>
    new PreflightFailed(`tool ${toolName}`, `could not connect to ${url} and list its tools: ${message}`, { cause }));
  try {
    const available = new Map(tools.map((tool) => [tool.name, tool]));
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
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** Describes an MCP server for an author: its tools and the schema_sha256 to pin each one. */
async function inspectMcp(context: HttpContext, url: URL, request: InspectRequest): Promise<string> {
  const { client, tools } = await connect(context, `inspect ${url}`, url, null, (message, cause) =>
    new ToolCallFailed(`inspect ${url}`, null, `could not list tools: ${message}. A server that needs a key cannot be inspected; read its documentation for tool names`, { cause }));
  await client.close();
  const chosen = tools.filter((tool) => (request.operations === undefined ? matchesSearch(request.search, tool.name, tool.description ?? "") : request.operations.includes(tool.name)));
  const lines = chosen.map((tool) => {
    const schema = tool.inputSchema as JsonObject;
    const detail = request.operations === undefined ? "" : `\n  arguments: ${JSON.stringify(schema)}`;
    return `- ${tool.name}: ${oneLine(tool.description ?? "")}\n  schema_sha256: ${canonicalHash(schema)}${detail}`;
  });
  return `MCP server ${url.href} offers ${tools.length} tools. Expose one by name, or as { name, schema_sha256 } to pin its input schema.\n\n${lines.join("\n")}`;
}

export const mcpKind: ToolKind = { prepare: prepareMcpTool, inspect: inspectMcp };
