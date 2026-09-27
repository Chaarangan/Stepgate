import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/engine/types.ts";
import { authorizeCredential } from "../src/authorize.ts";
import { environmentCredentials } from "../src/operator.ts";
import { userAgent } from "../src/version.ts";
import { API_KEY, REFRESH_TOKEN } from "./fixtures.ts";
import { resultText, startHarness, stateOf, use, GOOD_STOCK, GOOD_SUMMARY, type Harness, type Setup } from "./harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(setup: Setup): Promise<Harness> {
  harness = await startHarness(setup);
  return harness;
}

const OUTBOUND = { userAgent: userAgent(null), limits: { requestTimeoutMs: 5_000, responseBytes: 1_000_000 } };

/** Makes the suppliers credential an oauth2 one refreshed at this token URL, as an MCP server using MCP authorization needs. */
function oauthSuppliers(tokenPath: string): NonNullable<Setup["edit"]> {
  return (stepfile, { authorization }) => {
    const credentials = stepfile.credentials as Record<string, JsonObject>;
    credentials.suppliers = { ...credentials.suppliers, kind: "oauth2", scopes: ["read"], token_url: `${authorization ?? ""}${tokenPath}` };
  };
}

/** Plays the person in the browser: follows the authorization URL's redirects back to Stepgate's loopback callback. */
async function approveInBrowser(url: URL): Promise<void> {
  const response = await fetch(url);
  await response.text();
}

describe("stepgate auth", () => {
  it("authorizes an oauth2 credential with an MCP server's authorization server, and a run then reaches the tool", async () => {
    const env: Record<string, string> = { CATALOGUE_API_KEY: API_KEY };
    const { call, stepfile, authorization, mcp } = await start({
      authorization: true,
      edit: oauthSuppliers("/token"),
      credentialSource: environmentCredentials(env, OUTBOUND),
      actions: [use("getItem", { id: "K-1" }), use("lookup", { query: "Acme" }), GOOD_STOCK, GOOD_SUMMARY],
    });

    const variables = await authorizeCredential(stepfile, "suppliers", null, OUTBOUND, async () => {
      throw new Error("the test stepfile declares no settings");
    }, approveInBrowser);
    Object.assign(env, variables);
    const result = await call({ item: "K-1" });

    expect(variables).toEqual({ SUPPLIERS_REFRESH_TOKEN: REFRESH_TOKEN, SUPPLIERS_CLIENT_ID: "client-1", SUPPLIERS_RESOURCE: `${mcp.origin}/mcp` });
    expect(stateOf(result).state).toBe("finished");
    const authorize = new URL((authorization?.received.find((request) => request.path.startsWith("/authorize"))?.path ?? ""), "http://unused");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe(`${mcp.origin}/mcp`);
    const tokenRequests = (authorization?.received ?? []).filter((request) => request.path === "/token").map((request) => new URLSearchParams(request.body));
    expect(tokenRequests.map((form) => [form.get("grant_type"), form.get("resource")])).toEqual([
      ["authorization_code", `${mcp.origin}/mcp`],
      ["refresh_token", `${mcp.origin}/mcp`],
    ]);
  });

  it("fails preflight when the stepfile's token_url is not the token endpoint the MCP server's authorization server advertises", async () => {
    const env: Record<string, string> = { CATALOGUE_API_KEY: API_KEY, SUPPLIERS_REFRESH_TOKEN: REFRESH_TOKEN, SUPPLIERS_CLIENT_ID: "client-1" };
    const { call, authorization } = await start({
      authorization: true,
      edit: oauthSuppliers("/collect-tokens"),
      credentialSource: environmentCredentials(env, OUTBOUND),
      actions: [],
    });

    const result = await call({ item: "K-1" });

    expect(stateOf(result)).toMatchObject({ state: "failed", error: "PreflightFailed" });
    expect(resultText(result)).toContain(`credential suppliers: its token_url is ${authorization?.origin}/collect-tokens, but ${authorization?.origin}, the authorization server for`);
    expect(authorization?.received.some((request) => request.path === "/collect-tokens")).toBe(false);
  });

  it("fails preflight when the MCP server's metadata names another resource than the server the stepfile calls", async () => {
    const env: Record<string, string> = { CATALOGUE_API_KEY: API_KEY, SUPPLIERS_REFRESH_TOKEN: REFRESH_TOKEN, SUPPLIERS_CLIENT_ID: "client-1" };
    const { call, authorization } = await start({
      authorization: true,
      edit: (stepfile, addresses) => {
        oauthSuppliers("/token")(stepfile, addresses);
        const suppliers = (stepfile.tools as Record<string, { mcp: { url: string } }>).suppliers;
        if (suppliers !== undefined) {
          suppliers.mcp.url = suppliers.mcp.url.replace(/\/mcp$/, "/other");
        }
      },
      credentialSource: environmentCredentials(env, OUTBOUND),
      actions: [],
    });

    const result = await call({ item: "K-1" });

    expect(stateOf(result)).toMatchObject({ state: "failed", error: "PreflightFailed" });
    expect(resultText(result)).toMatch(/its protected resource metadata names resource http:\/\/127\.0\.0\.1:\d+\/mcp, not http:\/\/127\.0\.0\.1:\d+\/other/);
    expect(authorization?.received.some((request) => request.path === "/token")).toBe(false);
  });

  it("reports the authorization server and token endpoint of an MCP server that needs authorization", async () => {
    const { client, mcp, authorization } = await start({ authorization: true, actions: [] });

    const report = resultText(await client.callTool({ name: "stepgate_inspect_api", arguments: { kind: "mcp", url: `${mcp.origin}/mcp` } }) as Parameters<typeof resultText>[0]);

    expect(report).toContain(`authorization server ${authorization?.origin}`);
    expect(report).toContain(`token_url: ${authorization?.origin}/token`);
  });
});
