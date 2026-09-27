import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createStepgateServer, type StepgateServerOptions } from "./server.ts";
import type { Stepfile } from "./engine/types.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// The largest JSON-RPC message Stepgate accepts; a stepfile draft passed to stepgate_try is the biggest one expected.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

class RequestRejected extends Error {
  override name = "RequestRejected";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function hostname(authority: string): string | null {
  return URL.canParse(`http://${authority}`) ? new URL(`http://${authority}`).hostname : null;
}

/** Refuses a Host or Origin that is not loopback, so a web page cannot reach the server through DNS rebinding. */
function checkLoopback(request: IncomingMessage): void {
  const host = hostname(request.headers.host ?? "");
  if (host === null || !LOOPBACK.has(host)) {
    throw new RequestRejected(403, `Host ${request.headers.host ?? "(none)"} is not a loopback address`);
  }
  const origin = request.headers.origin;
  if (origin !== undefined && (!URL.canParse(origin) || !LOOPBACK.has(new URL(origin).hostname))) {
    throw new RequestRejected(403, `Origin ${origin} is not a loopback address`);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new RequestRejected(413, `request body is larger than ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RequestRejected(400, `request body is not JSON: ${(error as Error).message}`);
  }
}

function reject(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

type Session = { transport: StreamableHTTPServerTransport; timer: NodeJS.Timeout };

/**
 * Serves Streamable HTTP at /mcp on 127.0.0.1. Sessions are stateful, because a run lives in its session's server
 * between calls, and a session idle for `options.runIdleMs` is closed, which abandons its runs.
 */
export async function serveHttp(stepfiles: Stepfile[], options: StepgateServerOptions, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const sessions = new Map<string, Session>();
  const expire = (id: string) => setTimeout(() => {
    const session = sessions.get(id);
    sessions.delete(id);
    void session?.transport.close();
  }, options.runIdleMs).unref();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    checkLoopback(request);
    if (request.url !== "/mcp") {
      throw new RequestRejected(404, `no route ${request.url ?? ""}; the endpoint is /mcp`);
    }
    const body = request.method === "POST" ? await readJson(request) : undefined;
    const sessionId = request.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing !== undefined && typeof sessionId === "string") {
      clearTimeout(existing.timer);
      existing.timer = expire(sessionId);
      await existing.transport.handleRequest(request, response, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      throw new RequestRejected(400, "unknown session; start with initialize");
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => void sessions.set(id, { transport, timer: expire(id) }),
      onsessionclosed: (id) => {
        clearTimeout(sessions.get(id)?.timer);
        sessions.delete(id);
      },
    });
    // The MCP SDK's own types disagree under exactOptionalPropertyTypes; the runtime object is a Transport.
    await createStepgateServer(stepfiles, options).connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof RequestRejected) {
        reject(response, error.status, error.message);
        return;
      }
      process.stderr.write(`${JSON.stringify({ event: "http_request_failed", method: request.method, url: request.url, error: error instanceof Error ? error.message : String(error) })}\n`);
      if (!response.headersSent) {
        reject(response, 500, "internal error; see the server's standard error");
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await Promise.all([...sessions.values()].map(({ transport, timer }) => {
        clearTimeout(timer);
        return transport.close();
      }));
      await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
    },
  };
}
