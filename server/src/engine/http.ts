import { setTimeout as sleep } from "node:timers/promises";
import { EgressDenied, InvalidGrant, ToolCallFailed } from "./errors.ts";
import type { AppendRecord } from "./ledger.ts";
import type { CredentialDeclaration, RunContext } from "./types.ts";

const ATTEMPTS = 3;
const FIRST_BACKOFF_MS = 500;

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

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
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
    try {
      const response = await fetch(target, { ...init, headers });
      await raiseIfInvalidGrant(response, credential);
      if (!isRetryable(response.status)) {
        return response;
      }
      lastStatus = response.status;
      lastBody = await response.text();
      lastError = undefined;
    } catch (error) {
      if (error instanceof InvalidGrant) {
        throw error;
      }
      lastStatus = null;
      lastBody = error instanceof Error ? error.message : String(error);
      lastError = error;
    }
    if (attempt < ATTEMPTS) {
      await context.append("retry", { operation, attempt, status: lastStatus });
      await sleep(FIRST_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw new ToolCallFailed(operation, lastStatus, lastBody, lastError === undefined ? undefined : { cause: lastError });
}
