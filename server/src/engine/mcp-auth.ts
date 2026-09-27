import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AuthorizationFailed } from "./errors.ts";

/** What an MCP server using MCP authorization advertises: the resource a token is for, and its authorization server. */
export type McpAuthorization = { resource: string; issuer: string; metadata: AuthorizationServerMetadata; scopes: string[] };

/** RFC 9728 metadata locations for a server URL: the path-specific one first, then the root. */
function metadataUrls(server: URL): URL[] {
  const path = server.pathname.replace(/\/$/, "");
  const specific = new URL(`/.well-known/oauth-protected-resource${path}`, server);
  const root = new URL("/.well-known/oauth-protected-resource", server);
  return path === "" ? [root] : [specific, root];
}

type ProtectedResource = { resource?: unknown; authorization_servers?: unknown; scopes_supported?: unknown };

/** The server's RFC 9728 metadata, or null when neither location serves it. */
async function protectedResource(fetchFn: FetchLike, serverUrl: string): Promise<ProtectedResource | null> {
  for (const url of metadataUrls(new URL(serverUrl))) {
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    // As the MCP SDK does, any 4xx means nothing is published there: a server may guard every path, metadata included.
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new AuthorizationFailed(serverUrl, `its protected resource metadata at ${url.href} answered ${response.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as ProtectedResource;
    } catch {
      throw new AuthorizationFailed(serverUrl, `its protected resource metadata at ${url.href} is not JSON: ${text.slice(0, 500)}`);
    }
  }
  return null;
}

/**
 * Reads an MCP server's protected resource metadata and its authorization server's metadata. Null means the server
 * publishes no protected resource metadata, so it does not use MCP authorization; anything else missing raises.
 */
export async function discoverMcpAuthorization(fetchFn: FetchLike, serverUrl: string): Promise<McpAuthorization | null> {
  const published = await protectedResource(fetchFn, serverUrl);
  if (published === null) {
    return null;
  }
  const [issuer] = Array.isArray(published.authorization_servers) ? published.authorization_servers : [];
  if (typeof published.resource !== "string" || typeof issuer !== "string") {
    throw new AuthorizationFailed(serverUrl, "its protected resource metadata names no resource or no authorization server");
  }
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
  if (metadata === undefined) {
    throw new AuthorizationFailed(serverUrl, `its authorization server ${issuer} publishes no OAuth or OpenID Connect metadata`);
  }
  const scopes = Array.isArray(published.scopes_supported) ? published.scopes_supported.filter((scope: unknown): scope is string => typeof scope === "string") : [];
  return { resource: published.resource, issuer, metadata, scopes };
}
