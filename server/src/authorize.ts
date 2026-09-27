import { exchangeAuthorization, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthorizationFailed, StepgateError } from "./engine/errors.ts";
import type { HttpContext } from "./engine/http.ts";
import { discoverMcpAuthorization, tokenEndpointProblem, type McpAuthorization } from "./engine/mcp-auth.ts";
import { resolveSettings } from "./engine/settings.ts";
import type { RunContext, Stepfile } from "./engine/types.ts";
import { variableFor } from "./operator.ts";

// A person may take a while in the browser, but a forgotten prompt should not hold a port open for ever.
const CALLBACK_WAIT_MS = 10 * 60_000;

/** Listens on a loopback port for the authorization server's redirect, as RFC 8252 describes for native clients. */
async function listenForCallback(subject: string, state: string): Promise<{ redirectUrl: string; next: Promise<URLSearchParams>; close: () => void }> {
  let resolve: (params: URLSearchParams) => void = () => undefined;
  const next = new Promise<URLSearchParams>((settle, fail) => {
    resolve = settle;
    setTimeout(() => fail(new AuthorizationFailed(subject, `no redirect reached the loopback callback within ${CALLBACK_WAIT_MS / 60_000} minutes`)), CALLBACK_WAIT_MS).unref();
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Anything but the redirect for this request, such as another local page's probe, leaves the flow waiting.
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      response.writeHead(404).end();
      return;
    }
    const outcome = url.searchParams.has("error") ? "Stepgate received the authorization server's refusal; see the terminal." : "Stepgate received the authorization. You can close this tab.";
    response.writeHead(200, { "content-type": "text/plain" }).end(outcome);
    resolve(url.searchParams);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return { redirectUrl: `http://127.0.0.1:${port}/callback`, next, close: () => server.close() };
}

/** Checks the redirect's state and, per RFC 9207 as MCP authorization requires, its issuer, before the code is used. */
function codeFrom(subject: string, params: URLSearchParams, state: string, found: McpAuthorization): string {
  if (params.get("state") !== state) {
    throw new AuthorizationFailed(subject, "the redirect's state does not match the request, so it was not this authorization");
  }
  const iss = params.get("iss");
  const required = (found.metadata as { authorization_response_iss_parameter_supported?: unknown }).authorization_response_iss_parameter_supported === true;
  if ((iss === null && required) || (iss !== null && iss !== found.issuer)) {
    throw new AuthorizationFailed(subject, `the redirect's issuer ${iss ?? "(none)"} is not ${found.issuer}, so its code is not used`);
  }
  const error = params.get("error");
  if (error !== null) {
    throw new AuthorizationFailed(subject, `the authorization server refused: ${error} ${params.get("error_description") ?? ""}`.trim());
  }
  const code = params.get("code");
  if (code === null) {
    throw new AuthorizationFailed(subject, "the redirect carries no code");
  }
  return code;
}

/**
 * Runs MCP authorization for an oauth2 credential bound to an MCP tool and returns the environment variables the
 * operator sets: the refresh token, client id and resource Stepgate refreshes with, or an access token when no
 * refresh token is issued. It writes nothing to disk. `visit` sends the person to the authorization URL.
 */
export async function authorizeCredential(
  stepfile: Stepfile,
  credential: string,
  clientId: string | null,
  outbound: Pick<HttpContext, "userAgent">,
  settings: RunContext["settings"],
  visit: (url: URL) => Promise<void>,
): Promise<Record<string, string>> {
  const subject = `credential ${credential}`;
  const document = await resolveSettings(stepfile.document, { settings });
  const declaration = document.credentials?.[credential];
  if (declaration?.kind !== "oauth2") {
    throw new AuthorizationFailed(subject, `${stepfile.document.id} declares no oauth2 credential named ${credential}`);
  }
  const tool = Object.values(document.tools ?? {}).find((candidate) => candidate.credential === credential && candidate.mcp !== undefined);
  if (tool?.mcp === undefined) {
    throw new AuthorizationFailed(subject, "no MCP tool in the stepfile uses it; set its access token or refresh token by hand");
  }
  const fetchFn: FetchLike = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", outbound.userAgent);
    return fetch(url, { ...init, headers });
  };
  const found = await discoverMcpAuthorization(fetchFn, tool.mcp.url);
  if (found === null) {
    throw new AuthorizationFailed(subject, `${tool.mcp.url} publishes no protected resource metadata, so it does not use MCP authorization; set ${variableFor(credential, "API_KEY")} to its token instead`);
  }
  const problem = declaration.token_url === undefined ? `the stepfile declares no token_url; declare token_url: ${found.metadata.token_endpoint}` : tokenEndpointProblem(found, declaration.token_url);
  if (problem !== null) {
    throw new AuthorizationFailed(subject, problem);
  }
  const offline = (found.metadata.scopes_supported ?? []).includes("offline_access") && !(declaration.scopes ?? []).includes("offline_access");
  const scope = [...(declaration.scopes ?? []), ...(offline ? ["offline_access"] : [])].join(" ");
  const state = randomUUID();
  const callback = await listenForCallback(subject, state);
  try {
    let client: OAuthClientInformationMixed;
    if (clientId !== null) {
      client = { client_id: clientId };
    } else if (found.metadata.registration_endpoint !== undefined) {
      const metadata = { client_name: "Stepgate", redirect_uris: [callback.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" };
      client = await registerClient(found.issuer, { metadata: found.metadata, clientMetadata: metadata, fetchFn });
    } else {
      // TODO(mcp-auth-client-id): register through a Client ID Metadata Document once Stepgate hosts one.
      throw new AuthorizationFailed(subject, `${found.issuer} offers no dynamic client registration; pass --client-id with a client registered for http://127.0.0.1 redirects`);
    }
    const { authorizationUrl, codeVerifier } = await startAuthorization(found.issuer, { metadata: found.metadata, clientInformation: client, redirectUrl: callback.redirectUrl, scope, state, resource: new URL(found.resource) });
    await visit(authorizationUrl);
    const code = codeFrom(subject, await callback.next, state, found);
    const tokens = await exchangeAuthorization(found.issuer, { metadata: found.metadata, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri: callback.redirectUrl, resource: new URL(found.resource), fetchFn });
    if (tokens.refresh_token === undefined) {
      return { [variableFor(credential, "API_KEY")]: tokens.access_token };
    }
    return {
      [variableFor(credential, "REFRESH_TOKEN")]: tokens.refresh_token,
      [variableFor(credential, "CLIENT_ID")]: client.client_id,
      ...(client.client_secret === undefined ? {} : { [variableFor(credential, "CLIENT_SECRET")]: client.client_secret }),
      [variableFor(credential, "RESOURCE")]: found.resource,
    };
  } catch (error) {
    if (error instanceof StepgateError) {
      throw error;
    }
    throw new AuthorizationFailed(subject, (error as Error).message, { cause: error });
  } finally {
    callback.close();
  }
}
