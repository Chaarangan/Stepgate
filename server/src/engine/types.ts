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

/** An exposed operation: its name, or the name with an MCP schema pin and a `select` over its result. */
export type ExposedName = string | { name: string; schema_sha256?: string; select?: JsonObject };

export type ToolDeclaration = {
  openapi?: { server: string; document?: JsonObject; url?: string; sha256?: string };
  mcp?: { url: string };
  verifier?: { url: string };
  credential?: string;
  exposes?: ExposedName[];
};

export type Gate =
  | { id: string; schema: JsonSchema }
  | { id: string; predicate: JsonObject; message: string; explain?: JsonObject }
  | { id: string; http: { tool: string } }
  | { id: string; approve: { message: string } };

/** One call a mechanical step makes, with arguments as a template over inputs, earlier outputs and earlier responses. */
export type MechanicalCall = { id: string; operation: string; arguments?: JsonObject };

/** What Stepgate does for a mechanical step: its calls in order, then an output template over their responses. */
export type MechanicalWork = { calls?: MechanicalCall[]; output: Json };

/** An agent step has `instructions` and gates; a mechanical step has `do` instead, and its gates are optional. */
export type Step = {
  id: string;
  instructions?: string;
  do?: MechanicalWork;
  tools?: string[];
  produces: JsonSchema;
  gates?: Gate[];
  retries?: number;
  /** Top-level output fields Stepgate computes after the client submits; the client is not asked for them. */
  derive?: Record<string, JsonObject>;
  /** Named expressions evaluated in order once per submission, read by gates as `let.<name>`. */
  let?: Record<string, JsonObject>;
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

/** What an approve gate asks a person: the gate's message, with the output shown beneath it. */
export type ApprovalRequest = { stepfile: string; step: string; gate: string; message: string; output: Json };

/** A person's decision on approve gates, reached through the client; `available` is false when the client cannot ask one. */
export type Approvals = {
  available: boolean;
  ask: (request: ApprovalRequest) => Promise<{ approved: boolean; reason: string | null }>;
};

/** What a run needs from Stepgate: credentials, settings, a ledger sink and limits. */
export type RunContext = {
  approvals: Approvals;
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
