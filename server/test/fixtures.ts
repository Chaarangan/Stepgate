import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { CredentialUnavailable } from "../src/engine/errors.ts";
import type { CredentialDeclaration, RunContext } from "../src/engine/types.ts";

export const API_KEY = "api-key-5f1c9d";
export const MCP_TOKEN = "mcp-token-7a2e4b";

export type ReceivedRequest = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };

export type Fixture = { origin: string; host: string; received: ReceivedRequest[]; close: () => Promise<void> };

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<{ origin: string; host: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The catalogue's OpenAPI document, served byte for byte so its digest matches the base stepfile's. */
const OPENAPI_BYTES = readFileSync(new URL("fixtures/catalogue.openapi.json", import.meta.url));

/** A catalogue API, a verifier and the OpenAPI document describing them. `flakyFailures` 503s precede success. */
export async function startApi(flakyFailures: number): Promise<Fixture> {
  const received: ReceivedRequest[] = [];
  let flakyCalls = 0;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = request.url ?? "/";
    received.push({ method: request.method ?? "", path, headers: request.headers, body });
    if (path === "/openapi.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(OPENAPI_BYTES);
      return;
    }
    if (path === "/verify") {
      const { output } = JSON.parse(body) as { output: { count: number } };
      send(response, 200, output.count >= 3 ? { pass: true } : { pass: false, message: `count ${output.count} is below 3` });
      return;
    }
    if (request.headers["x-api-key"] !== API_KEY) {
      send(response, 401, { error: "unauthorised" });
      return;
    }
    if (path === "/revoked") {
      send(response, 401, { error: "invalid_grant" });
      return;
    }
    if (path === "/flaky") {
      flakyCalls += 1;
      send(response, flakyCalls <= flakyFailures ? 503 : 200, flakyCalls <= flakyFailures ? { error: "busy" } : { ok: true });
      return;
    }
    const match = /^\/items\/([^/?]+)$/.exec(path);
    if (request.method === "GET" && match !== null) {
      send(response, 200, { id: decodeURIComponent(match[1] ?? ""), name: "Blue kettle", stock: 4 });
      return;
    }
    send(response, 404, { error: "not found", path });
  });
  return { ...(await listen(server)), received };
}

/** A stateless Streamable HTTP MCP server offering `lookup`, which requires the bearer token. */
export async function startMcp(): Promise<Fixture> {
  const received: ReceivedRequest[] = [];
  const server = createServer(async (request, response) => {
    received.push({ method: request.method ?? "", path: request.url ?? "/", headers: request.headers, body: "" });
    if (request.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
      send(response, 401, { error: "unauthorised" });
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: "method not allowed" });
      return;
    }
    const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
    mcp.registerTool(
      "lookup",
      { description: "Look up a supplier by name.", inputSchema: { query: z.string() } },
      async ({ query }) => ({ content: [{ type: "text", text: `Supplier ${query}: based in Leeds` }] }),
    );
    // No sessionIdGenerator makes the transport stateless, which the MCP SDK documents as passing undefined.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport as Transport);
    await transport.handleRequest(request, response);
  });
  return { ...(await listen(server)), received };
}

export function secretsFrom(values: Record<string, string>): RunContext["credentials"] {
  return async (name: string, _declaration: CredentialDeclaration) => {
    const value = values[name];
    if (value === undefined) {
      throw new CredentialUnavailable(name, "not set in the test environment");
    }
    return value;
  };
}
