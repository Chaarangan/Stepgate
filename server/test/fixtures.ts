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
export const BASIC_CREDENTIAL = "user@example.com:basic-token-3c9f";

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
  let tokensIssued = 0;
  const limitedCalls: Record<string, number> = {};
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = request.url ?? "/";
    received.push({ method: request.method ?? "", path, headers: request.headers, body });
    if (path === "/openapi.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(OPENAPI_BYTES);
      return;
    }
    if (path === "/verify-garbage") {
      response.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>");
      return;
    }
    if (path === "/verify") {
      const { output } = JSON.parse(body) as { output: { count: number } };
      send(response, 200, output.count >= 3 ? { pass: true } : { pass: false, message: `count ${output.count} is below 3` });
      return;
    }
    if (path === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      if (form.get("refresh_token") === "revoked") {
        send(response, 400, { error: "invalid_grant", error_description: "Token has been revoked." });
        return;
      }
      tokensIssued += 1;
      send(response, 200, { access_token: `fresh-${tokensIssued}`, expires_in: 3600, refresh_token: `rotated-${tokensIssued}`, token_type: "Bearer" });
      return;
    }
    const oauth = /^\/oauth(-strict)?-items\/([^/?]+)$/.exec(path);
    if (oauth !== null) {
      const token = /^Bearer fresh-(\d+)$/.exec(request.headers.authorization ?? "")?.[1];
      const ok = token !== undefined && (oauth[1] === undefined || Number(token) > 1);
      send(response, ok ? 200 : 401, ok ? { id: decodeURIComponent(oauth[2] ?? ""), name: "Blue kettle", stock: 4 } : { error: "invalid_token" });
      return;
    }
    const basic = /^\/basic-items\/([^/?]+)$/.exec(path);
    if (basic !== null) {
      const ok = request.headers.authorization === `Basic ${Buffer.from(BASIC_CREDENTIAL).toString("base64")}`;
      send(response, ok ? 200 : 401, ok ? { id: decodeURIComponent(basic[1] ?? ""), name: "Blue kettle", stock: 4 } : { error: "unauthorised" });
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
    if (path === "/limited" || path === "/secondary-limited" || path === "/limited-long") {
      limitedCalls[path] = (limitedCalls[path] ?? 0) + 1;
      if (path === "/limited-long") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "120" }).end("{\"error\":\"slow down\"}");
      } else if (limitedCalls[path] === 1 && path === "/limited") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end("{\"error\":\"slow down\"}");
      } else if (limitedCalls[path] === 1) {
        const reset = String(Math.ceil(Date.now() / 1000) + 1);
        response.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }).end("{\"message\":\"API rate limit exceeded\"}");
      } else {
        send(response, 200, { ok: true });
      }
      return;
    }
    if (path === "/redirect-away") {
      const port = request.headers.host?.split(":")[1] ?? "";
      response.writeHead(302, { location: `http://localhost:${port}/items/K-1` }).end();
      return;
    }
    if (path === "/redirect-home") {
      response.writeHead(302, { location: "/items/K-1" }).end();
      return;
    }
    if (path === "/busy") {
      send(response, 503, { error: "busy" });
      return;
    }
    if (path === "/slow") {
      setTimeout(() => send(response, 200, { ok: true }), 1000).unref();
      return;
    }
    if (path === "/huge") {
      send(response, 200, { padding: "x".repeat(2_000_000) });
      return;
    }
    if (path.startsWith("/search?")) {
      send(response, 200, { tags: new URL(path, "http://fixture").searchParams.getAll("tag"), results: [] });
      return;
    }
    if (path === "/drafts" && request.method === "POST") {
      send(response, 201, { id: "draft-1", content_type: request.headers["content-type"], bytes: Buffer.byteLength(body) });
      return;
    }
    const formatted = /^\/formatted\/([^/?]+)\?format=json$/.exec(path);
    if (formatted !== null) {
      send(response, 200, { id: decodeURIComponent(formatted[1] ?? ""), name: "Blue kettle", stock: 4 });
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
export async function startMcp(authorizationServer: string | null): Promise<Fixture> {
  const received: ReceivedRequest[] = [];
  let origin = "";
  const server = createServer(async (request, response) => {
    received.push({ method: request.method ?? "", path: request.url ?? "/", headers: request.headers, body: "" });
    // With an authorization server, the fixture publishes RFC 9728 metadata naming it, as MCP authorization requires.
    if (authorizationServer !== null && (request.url ?? "").startsWith("/.well-known/oauth-protected-resource")) {
      send(response, 200, { resource: `${origin}/mcp`, authorization_servers: [authorizationServer], scopes_supported: ["read"] });
      return;
    }
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
  const listening = await listen(server);
  origin = listening.origin;
  return { ...listening, received };
}

export const REFRESH_TOKEN = "refresh-token-91d0";

/**
 * An OAuth authorization server for the MCP fixture: RFC 8414 metadata, dynamic client registration, an authorize
 * endpoint that approves at once by redirecting with a code and `iss`, and a token endpoint issuing MCP_TOKEN.
 */
export async function startAuthorizationServer(): Promise<Fixture> {
  const received: ReceivedRequest[] = [];
  let origin = "";
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    received.push({ method: request.method ?? "", path: request.url ?? "/", headers: request.headers, body });
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      send(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["read", "offline_access"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      send(response, 201, { ...(JSON.parse(body) as object), client_id: "client-1" });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "code-1");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      redirect.searchParams.set("iss", origin);
      response.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      const granted = form.get("grant_type") === "authorization_code" ? form.get("code") === "code-1" && form.get("code_verifier") !== null
        : form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH_TOKEN;
      send(response, granted ? 200 : 400, granted
        ? { access_token: MCP_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH_TOKEN }
        : { error: "invalid_grant" });
      return;
    }
    send(response, 404, { error: "not found" });
  });
  const listening = await listen(server);
  origin = listening.origin;
  return { ...listening, received };
}

/** Fixed values, as an operator's static keys are; a rejected one is never replaced. */
export function secretsFrom(values: Record<string, string>): RunContext["credentials"] {
  return {
    value: async (name: string, _declaration: CredentialDeclaration) => {
      const value = values[name];
      if (value === undefined) {
        throw new CredentialUnavailable(name, "not set in the test environment");
      }
      return value;
    },
    rejected: async () => false,
  };
}
