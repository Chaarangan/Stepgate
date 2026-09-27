import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialUnavailable, SettingUnavailable } from "../src/engine/errors.ts";
import { isPublicHttpsUrl } from "../src/engine/http.ts";
import { serveHttp } from "../src/http-server.ts";
import { userAgent } from "../src/version.ts";

let served: Awaited<ReturnType<typeof serveHttp>> | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

async function start(): Promise<number> {
  served = await serveHttp([], {
    credentials: {
      value: async (name) => {
        throw new CredentialUnavailable(name, "none in this test");
      },
      rejected: async () => false,
    },
    settings: async (name) => {
      throw new SettingUnavailable(name, "none in this test");
    },
    ledger: () => undefined,
    limits: { callsPerStep: 8, toolResultChars: 10_000, requestTimeoutMs: 5_000, responseBytes: 1_000_000 },
    runIdleMs: 60_000,
    userAgent: userAgent(null),
    drafts: { urlAllowed: isPublicHttpsUrl },
  }, 0);
  return served.port;
}

/** A raw request, since fetch will not let a caller set Host. */
function post(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("HTTP mode", () => {
  it("serves an MCP client on the loopback address", async () => {
    const port = await start();
    const client = new Client({ name: "platform", version: "1.0.0" });

    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as Transport);
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("stepgate_guide");
  });

  it("refuses a Host or Origin that is not loopback, which is how DNS rebinding would reach it", async () => {
    const port = await start();

    const host = await post(port, { host: `evil.example:${port}` }, "{}");
    const origin = await post(port, { origin: "https://evil.example" }, "{}");

    expect(host).toMatchObject({ status: 403, body: expect.stringContaining("Host evil.example") });
    expect(origin).toMatchObject({ status: 403, body: expect.stringContaining("Origin https://evil.example") });
  });

  it("answers a body that is not JSON with 400 and one past the size limit with 413", async () => {
    const port = await start();

    const malformed = await post(port, {}, "{not json");
    const oversized = await post(port, {}, JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }));

    expect(malformed).toMatchObject({ status: 400, body: expect.stringContaining("not JSON") });
    expect(oversized.status).toBe(413);
  });
});
