import { setTimeout as sleep } from "node:timers/promises";
import { EgressDenied, InvalidGrant, ToolCallFailed } from "./errors.ts";
import type { AppendRecord } from "./ledger.ts";
import type { CredentialDeclaration, RunContext } from "./types.ts";

const ATTEMPTS = 4;
const FIRST_BACKOFF_MS = 500;
// The longest a rate-limited API may ask Stepgate to wait before a retry; longer asks end the call.
const MAX_WAIT_MS = 60_000;

export type CredentialBinding = {
  name: string;
  declaration: CredentialDeclaration;
  /** Where the secret goes on this request, e.g. an Authorization header. */
  place: (secret: string, headers: Headers, url: URL) => void;
};

export type HttpContext = {
  runContext: RunContext;
  allowedHosts: ReadonlySet<string>;
  append: AppendRecord;
};

/** How long the response asks the caller to wait, from Retry-After or GitHub-style rate-limit headers. */
function requestedWaitMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return null;
}

/** 429 and 5xx are retried, and so is a 403 that carries rate-limit headers, as GitHub sends. */
function isRetryable(response: Response): boolean {
  return response.status === 429 || response.status >= 500 || (response.status === 403 && requestedWaitMs(response) !== null);
}

async function raiseIfInvalidGrant(response: Response, credential: CredentialBinding | null): Promise<void> {
  if (credential === null || (response.status !== 400 && response.status !== 401)) {
    return;
  }
  const body = await response.clone().text();
  if (/"error"\s*:\s*"invalid_grant"/.test(body)) {
    throw new InvalidGrant(credential.name, body.slice(0, 500));
  }
}

/**
 * Sends one request on behalf of a stepfile: refuses undeclared hosts, resolves the credential
 * afresh on every attempt, retries 429/5xx and network errors with a ledger record, then raises.
 */
export async function guardedFetch(
  context: HttpContext,
  operation: string,
  url: URL,
  init: RequestInit,
  credential: CredentialBinding | null,
): Promise<Response> {
  if (!context.allowedHosts.has(url.host)) {
    throw new EgressDenied(url.host, operation);
  }
  let lastStatus: number | null = null;
  let lastBody = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", context.runContext.userAgent);
    }
    const target = new URL(url);
    if (credential !== null) {
      credential.place(await context.runContext.credentials(credential.name, credential.declaration), headers, target);
    }
    let waitMs = FIRST_BACKOFF_MS * 2 ** (attempt - 1);
    try {
      const response = await fetch(target, { ...init, headers });
      await raiseIfInvalidGrant(response, credential);
      if (!isRetryable(response)) {
        return response;
      }
      lastStatus = response.status;
      lastBody = await response.text();
      lastError = undefined;
      const requested = requestedWaitMs(response);
      if (requested !== null && requested > MAX_WAIT_MS) {
        throw new ToolCallFailed(operation, lastStatus, `rate limited: asked to wait ${Math.round(requested / 1000)}s, more than the ${MAX_WAIT_MS / 1000}s Stepgate allows. ${lastBody}`);
      }
      waitMs = requested ?? waitMs;
    } catch (error) {
      if (error instanceof InvalidGrant || error instanceof ToolCallFailed) {
        throw error;
      }
      lastStatus = null;
      lastBody = error instanceof Error ? error.message : String(error);
      lastError = error;
    }
    if (attempt < ATTEMPTS) {
      await context.append("retry", { operation, attempt, status: lastStatus, wait_ms: Math.round(waitMs) });
      await sleep(waitMs);
    }
  }
  throw new ToolCallFailed(operation, lastStatus, lastBody, lastError === undefined ? undefined : { cause: lastError });
}
