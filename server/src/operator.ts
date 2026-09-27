import { CredentialUnavailable, InvalidGrant, SettingUnavailable, ToolCallFailed } from "./engine/errors.ts";
import { guardedFetch, readText, type HttpContext } from "./engine/http.ts";
import type { CredentialDeclaration, CredentialSource, RunContext } from "./engine/types.ts";

// Refresh this long before the provider's stated expiry, so a token does not lapse between reading and sending it.
const EXPIRY_MARGIN_MS = 60_000;

type Environment = Readonly<Record<string, string | undefined>>;

/** The environment variable for a name: `jira-site` is JIRA_SITE, and with a suffix `crm` is CRM_API_KEY. */
export function variableFor(name: string, suffix: string | null): string {
  const base = name.toUpperCase().replaceAll("-", "_");
  return suffix === null ? base : `${base}_${suffix}`;
}

function read(env: Environment, variable: string): string | null {
  const value = env[variable];
  return value === undefined || value === "" ? null : value;
}

/** Setting `<name>` from `<NAME>`. */
export function environmentSettings(env: Environment): RunContext["settings"] {
  return async (name) => {
    const variable = variableFor(name, null);
    const value = read(env, variable);
    if (value === null) {
      throw new SettingUnavailable(name, `set ${variable} in the server's environment`);
    }
    return value;
  };
}

type Token = { value: string; expiresAt: number | null };

/**
 * Credential `<name>` from the environment. An oauth2 credential with `<NAME>_REFRESH_TOKEN` and `<NAME>_CLIENT_ID`
 * set (and `<NAME>_CLIENT_SECRET` for a confidential client) is exchanged at the stepfile's `token_url` and refreshed
 * before it expires or when an API rejects it. Anything else is `<NAME>_API_KEY`, sent as it is.
 */
export function environmentCredentials(env: Environment, outbound: Pick<HttpContext, "userAgent" | "limits">): CredentialSource {
  const tokens = new Map<string, Token>();
  const refreshing = new Map<string, Promise<Token>>();
  // A provider that rotates refresh tokens returns a new one with each access token; it lives here, since the environment cannot be rewritten.
  const rotated = new Map<string, string>();

  const refreshable = (name: string, declaration: CredentialDeclaration): boolean =>
    declaration.kind === "oauth2" && read(env, variableFor(name, "REFRESH_TOKEN")) !== null;

  const refresh = async (name: string, declaration: CredentialDeclaration): Promise<Token> => {
    const clientId = read(env, variableFor(name, "CLIENT_ID"));
    if (declaration.token_url === undefined || clientId === null) {
      throw new CredentialUnavailable(name, declaration.token_url === undefined
        ? `the stepfile declares no token_url, so ${variableFor(name, "REFRESH_TOKEN")} cannot be exchanged; set ${variableFor(name, "API_KEY")} to an access token instead`
        : `set ${variableFor(name, "CLIENT_ID")} beside ${variableFor(name, "REFRESH_TOKEN")}`);
    }
    const url = new URL(declaration.token_url);
    const operation = `refresh credential ${name}`;
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: rotated.get(name) ?? read(env, variableFor(name, "REFRESH_TOKEN")) ?? "", client_id: clientId });
    const secret = read(env, variableFor(name, "CLIENT_SECRET"));
    if (secret !== null) {
      form.set("client_secret", secret);
    }
    if ((declaration.scopes ?? []).length > 0) {
      form.set("scope", (declaration.scopes ?? []).join(" "));
    }
    // MCP authorization requires the RFC 8707 resource on every token request; stepgate --auth prints its value.
    const resource = read(env, variableFor(name, "RESOURCE"));
    if (resource !== null) {
      form.set("resource", resource);
    }
    // The source outlives any one run, so its requests leave no retry records in a run's ledger.
    const context: HttpContext = { ...outbound, allowedHosts: new Set([url.host]), append: async () => undefined, credentials: { value: async () => "", rejected: async () => false } };
    const response = await guardedFetch(context, operation, url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() }, null);
    const text = await readText(response, operation);
    if (/"error"\s*:\s*"invalid_grant"/.test(text)) {
      throw new InvalidGrant(name, text.slice(0, 500));
    }
    if (!response.ok) {
      throw new ToolCallFailed(operation, response.status, text);
    }
    let reply: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      throw new ToolCallFailed(operation, response.status, `token response is not JSON: ${text.slice(0, 500)}`);
    }
    if (typeof reply.access_token !== "string" || reply.access_token === "") {
      throw new ToolCallFailed(operation, response.status, "token response has no access_token");
    }
    if (typeof reply.refresh_token === "string" && reply.refresh_token !== "") {
      rotated.set(name, reply.refresh_token);
    }
    const expiresAt = typeof reply.expires_in === "number" ? Date.now() + reply.expires_in * 1000 - EXPIRY_MARGIN_MS : null;
    return { value: reply.access_token, expiresAt };
  };

  // Concurrent requests for one credential share a single refresh.
  const fresh = async (name: string, declaration: CredentialDeclaration): Promise<Token> => {
    const pending = refreshing.get(name) ?? refresh(name, declaration).finally(() => refreshing.delete(name));
    refreshing.set(name, pending);
    const token = await pending;
    tokens.set(name, token);
    return token;
  };

  return {
    value: async (name, declaration) => {
      if (refreshable(name, declaration)) {
        const cached = tokens.get(name);
        const usable = cached !== undefined && (cached.expiresAt === null || cached.expiresAt > Date.now());
        return (usable ? cached : await fresh(name, declaration)).value;
      }
      const variable = variableFor(name, "API_KEY");
      const value = read(env, variable);
      if (value === null) {
        throw new CredentialUnavailable(name, declaration.kind === "oauth2"
          ? `set ${variable} to an access token, or ${variableFor(name, "REFRESH_TOKEN")} and ${variableFor(name, "CLIENT_ID")} to have Stepgate refresh one`
          : `set ${variable} in the server's environment`);
      }
      return value;
    },
    rejected: async (name, declaration) => {
      if (!refreshable(name, declaration)) {
        return false;
      }
      tokens.delete(name);
      await fresh(name, declaration);
      return true;
    },
  };
}
