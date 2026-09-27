import { setTimeout as sleep } from "node:timers/promises";
import { EgressDenied, InvalidGrant, ResponseTooLarge, StepgateError, ToolCallFailed } from "./errors.ts";
import type { AppendRecord } from "./ledger.ts";
import type { CredentialDeclaration, RunContext } from "./types.ts";

const ATTEMPTS = 4;
const FIRST_BACKOFF_MS = 500;
// The longest a rate-limited API may ask Stepgate to wait before a retry; longer asks end the call.
const MAX_WAIT_MS = 60_000;
const MAX_REDIRECTS = 5;
// RFC 9110 9.2.2: repeating these has the effect of sending once, so only they are retried after a 5xx or a network error.
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export type CredentialBinding = {
  name: string;
  declaration: CredentialDeclaration;
  /** Where the secret goes on this request, e.g. an Authorization header. */
  place: (secret: string, headers: Headers, url: URL) => void;
};

/** What one outbound request needs: the hosts it may reach, where retries are recorded, and the operator's identity, secrets and limits. */
export type HttpContext = {
  allowedHosts: ReadonlySet<string>;
  append: AppendRecord;
  userAgent: string;
  credentials: RunContext["credentials"];
  limits: Pick<RunContext["limits"], "requestTimeoutMs" | "responseBytes">;
};

const PRIVATE_IPV4 = /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * True for an https URL whose host has a dot and is not a loopback, private, shared or link-local address or a
 * local-only name. It reads the name only; a public name that resolves to a private address still passes.
 */
export function isPublicHttpsUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const { protocol, hostname } = new URL(url);
  const host = hostname.toLowerCase();
  if (protocol !== "https:" || host.startsWith("[") || !host.includes(".") || /\.(local|localhost|internal)$/.test(host)) {
    return false;
  }
  return !(/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_IPV4.test(host));
}

/** True for a plain http URL on a loopback address, which only tests let drafts and inspection reach. */
export function isLoopbackHttpUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

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

/** A rate limit (429, or a 403 with rate-limit headers as GitHub sends) was not processed, so any method retries; a 5xx retries only an idempotent one. */
function isRetryable(response: Response, idempotent: boolean): boolean {
  const limited = response.status === 429 || (response.status === 403 && requestedWaitMs(response) !== null);
  return limited || (idempotent && response.status >= 500);
}

/** The response with a body that errors with ResponseTooLarge past the limit, so no caller can read an unbounded body. */
function capped(response: Response, operation: string, limit: number): Response {
  if (response.body === null || NULL_BODY_STATUSES.has(response.status)) {
    return response;
  }
  let total = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        controller.error(new ResponseTooLarge(operation, limit));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Reads a response from guardedFetch as text. A body cut off by the deadline or the size limit raises a named error. */
export async function readText(response: Response, operation: string): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (error instanceof StepgateError) {
      throw error;
    }
    throw new ToolCallFailed(operation, response.status, `reading the response failed: ${describe(error)}`, { cause: error });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "no response before the request deadline";
  }
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return error instanceof Error ? `${error.message}${cause}` : String(error);
}

async function raiseIfInvalidGrant(response: Response, credential: CredentialBinding | null, operation: string): Promise<void> {
  if (credential === null || (response.status !== 400 && response.status !== 401)) {
    return;
  }
  const body = await readText(response.clone(), operation);
  if (/"error"\s*:\s*"invalid_grant"/.test(body)) {
    throw new InvalidGrant(credential.name, body.slice(0, 500));
  }
}

/**
 * The deadline for one request. The MCP client's GET event stream stays open to receive server messages,
 * so it has no deadline; everything else must answer within requestTimeoutMs, body included.
 */
function deadline(init: RequestInit, method: string, headers: Headers, timeoutMs: number): AbortSignal | null {
  const listening = method === "GET" && headers.get("accept") === "text/event-stream";
  const signals = [init.signal ?? null, listening ? null : AbortSignal.timeout(timeoutMs)].filter((signal) => signal !== null);
  return signals.length === 0 ? null : AbortSignal.any(signals);
}

/** One attempt, following redirects itself so every hop is checked against the allowlist and the credential's hosts. */
async function send(context: HttpContext, operation: string, url: URL, init: RequestInit, credential: CredentialBinding | null): Promise<Response> {
  let target = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; ; hop += 1) {
    if (!context.allowedHosts.has(target.host)) {
      throw new EgressDenied(target.host, operation);
    }
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", context.userAgent);
    }
    if (body === undefined || body === null) {
      headers.delete("content-type");
    }
    const request = new URL(target);
    if (credential !== null && credential.declaration.hosts.includes(target.host)) {
      credential.place(await context.credentials.value(credential.name, credential.declaration), headers, request);
    }
    const response = await fetch(request, { ...init, method, body: body ?? null, headers, redirect: "manual", signal: deadline(init, method, headers, context.limits.requestTimeoutMs) });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || location === null) {
      return capped(response, operation, context.limits.responseBytes);
    }
    await response.body?.cancel();
    if (hop === MAX_REDIRECTS) {
      throw new ToolCallFailed(operation, response.status, `stopped after ${MAX_REDIRECTS} redirects, the last to ${location}`);
    }
    // Fetch's own rule: a 303, or a 301 or 302 answering a POST, is followed with a GET and no body.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    target = new URL(location, target);
  }
}

/**
 * Sends one request on behalf of a stepfile: refuses undeclared hosts on every hop, resolves the credential afresh on
 * every attempt, bounds time and size, retries what is safe to retry with a ledger record, then raises the last error.
 */
export async function guardedFetch(
  context: HttpContext,
  operation: string,
  url: URL,
  init: RequestInit,
  credential: CredentialBinding | null,
): Promise<Response> {
  const idempotent = IDEMPOTENT.has((init.method ?? "GET").toUpperCase());
  let lastStatus: number | null = null;
  let lastBody = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let waitMs = FIRST_BACKOFF_MS * 2 ** (attempt - 1);
    try {
      let response = await send(context, operation, url, init, credential);
      await raiseIfInvalidGrant(response, credential, operation);
      // A 401 was not processed, so after the source replaces an expired or revoked token the request is sent once more.
      if (response.status === 401 && credential !== null && await context.credentials.rejected(credential.name, credential.declaration)) {
        await response.body?.cancel();
        response = await send(context, operation, url, init, credential);
        await raiseIfInvalidGrant(response, credential, operation);
      }
      if (!isRetryable(response, idempotent)) {
        return response;
      }
      lastStatus = response.status;
      lastBody = await readText(response, operation);
      lastError = undefined;
      const requested = requestedWaitMs(response);
      if (requested !== null && requested > MAX_WAIT_MS) {
        throw new ToolCallFailed(operation, lastStatus, `rate limited: asked to wait ${Math.round(requested / 1000)}s, more than the ${MAX_WAIT_MS / 1000}s Stepgate allows. ${lastBody}`);
      }
      waitMs = requested ?? waitMs;
    } catch (error) {
      if (error instanceof StepgateError) {
        throw error;
      }
      if (!idempotent) {
        throw new ToolCallFailed(operation, null, `${describe(error)}; not retried, because a ${init.method ?? "GET"} may already have taken effect`, { cause: error });
      }
      lastStatus = null;
      lastBody = describe(error);
      lastError = error;
    }
    if (attempt < ATTEMPTS) {
      await context.append("retry", { operation, attempt, status: lastStatus, wait_ms: Math.round(waitMs) });
      await sleep(waitMs);
    }
  }
  throw new ToolCallFailed(operation, lastStatus, lastBody, lastError === undefined ? undefined : { cause: lastError });
}
