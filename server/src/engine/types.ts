export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type JsonSchema = JsonObject;

export type CredentialKind = "api_key" | "bearer" | "oauth2" | "basic";

export type SettingDeclaration = { description: string; pattern?: string };

export type CredentialDeclaration = {
  kind: CredentialKind;
  scopes?: string[];
  /** For oauth2: where Stepgate exchanges the operator's refresh token for an access token. */
  token_url?: string;
  hosts: string[];
  description: string;
};

export type ExposedName = string | { name: string; schema_sha256: string };

export type ToolDeclaration = {
  openapi?: { server: string; document?: JsonObject; url?: string; sha256?: string };
  mcp?: { url: string };
  verifier?: { url: string };
  credential?: string;
  exposes?: ExposedName[];
};

export type Gate =
  | { id: string; schema: JsonSchema }
  | { id: string; predicate: JsonObject; message: string }
  | { id: string; http: { tool: string } };

export type Step = {
  id: string;
  instructions: string;
  tools?: string[];
  produces: JsonSchema;
  gates: Gate[];
  retries?: number;
  when?: JsonObject;
};

/** A stepfile as written, after schema validation. */
export type StepfileDocument = {
  stepgate: "1";
  id: string;
  title?: string;
  description?: string;
  inputs: JsonSchema;
  settings?: Record<string, SettingDeclaration>;
  credentials?: Record<string, CredentialDeclaration>;
  tools?: Record<string, ToolDeclaration>;
  steps: Step[];
  $defs?: Record<string, JsonSchema>;
};

/** A validated stepfile and its identity, as returned by `load`. */
export type Stepfile = {
  document: StepfileDocument;
  identity: string;
};

/** An operation a step offers the client, with the schema its arguments must match. */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type LedgerRecord = { seq: number; type: string; at: string; prev: string | null } & JsonObject;

/** Where credential values come from. Stepgate asks again on every attempt, so a source may rotate them. */
export type CredentialSource = {
  /** The value to send now; raises CredentialUnavailable when the operator supplied none. */
  value: (name: string, declaration: CredentialDeclaration) => Promise<string>;
  /** Told that an API answered 401 to the value; true when a fresh one was obtained and the request is worth sending once more. */
  rejected: (name: string, declaration: CredentialDeclaration) => Promise<boolean>;
};

/** What a run needs from Stepgate: credentials, settings, a ledger sink and limits. */
export type RunContext = {
  credentials: CredentialSource;
  /** The operator's value for a setting, such as a site name; raises SettingUnavailable when unset. */
  settings: (name: string, declaration: SettingDeclaration) => Promise<string>;
  ledger: (record: LedgerRecord) => void | Promise<void>;
  /** Budgets: tool calls one step may make, the longest tool result passed to the client, and the time and size one request may take. */
  limits: { callsPerStep: number; toolResultChars: number; requestTimeoutMs: number; responseBytes: number };
  /** Sent on every outgoing request that does not set its own. */
  userAgent: string;
};

export type RunResult = {
  identity: string;
  outputs: Record<string, JsonObject>;
};
