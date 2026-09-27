import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Json, JsonObject } from "../src/engine/types.ts";

/** One answer a route gives: a status, headers, and a JSON or text body. `{origin}`, `{host}` and `{port}` in a header are the fixture's own. */
export type RouteAnswer = { status: number; headers?: Record<string, string>; json?: Json; text?: string };
/** A route answers in order and repeats its last answer; `bearer` makes it answer 401 to any other Authorization. */
export type Route = { method: string; path: string; answers: RouteAnswer[]; bearer?: string; key?: { header: string; value: string } };
export type ToolFixture = { name: string; description: string; inputSchema: JsonObject; text: string };
export type Received = { method: string; path: string; headers: Record<string, string> };
export type Fixture = { origin: string; host: string; received: Received[]; close: () => Promise<void> };

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])));
}

async function listen(server: HttpServer, received: Received[]): Promise<Fixture> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** An HTTP API that answers only the routes a case declares, and 404 to anything else. */
export async function startRoutes(routes: Route[]): Promise<Fixture> {
  const received: Received[] = [];
  const served = new Map<Route, number>();
  let origin = "";
  const server = createServer(async (request, response) => {
    await readBody(request);
    const path = request.url ?? "/";
    received.push({ method: request.method ?? "", path, headers: headersOf(request) });
    const route = routes.find((candidate) => candidate.method === request.method && candidate.path === path);
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no such route", path }));
      return;
    }
    if ((route.bearer !== undefined && request.headers.authorization !== `Bearer ${route.bearer}`)
      || (route.key !== undefined && request.headers[route.key.header.toLowerCase()] !== route.key.value)) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorised" }));
      return;
    }
    const index = served.get(route) ?? 0;
    served.set(route, index + 1);
    const answer = route.answers[Math.min(index, route.answers.length - 1)] as RouteAnswer;
    const host = origin.replace("http://", "");
    const port = host.split(":")[1] ?? "";
    const headers = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([name, value]) => [name, value.replaceAll("{origin}", origin).replaceAll("{host}", host).replaceAll("{port}", port)]));
    const body = answer.json === undefined ? (answer.text ?? "") : JSON.stringify(answer.json);
    response.writeHead(answer.status, { "content-type": answer.json === undefined ? "text/plain" : "application/json", ...headers }).end(body);
  });
  const fixture = await listen(server, received);
  origin = fixture.origin;
  return fixture;
}

/** A stateless Streamable HTTP MCP server offering the case's tools, each answering with fixed text, behind a bearer token. */
export async function startTools(tools: ToolFixture[], token: string): Promise<Fixture> {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    received.push({ method: request.method ?? "", path: request.url ?? "/", headers: headersOf(request) });
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorised" }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const mcp = new Server({ name: "conformance", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: "object" } })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = tools.find((candidate) => candidate.name === call.params.name);
      return tool === undefined
        ? { content: [{ type: "text" as const, text: `no tool ${call.params.name}` }], isError: true }
        : { content: [{ type: "text" as const, text: tool.text }] };
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport as Transport);
    await transport.handleRequest(request, response);
  });
  return listen(server, received);
}
