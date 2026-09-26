export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type JsonSchema = JsonObject;

export type CredentialKind = "api_key" | "bearer" | "oauth2";

export type CredentialDeclaration = {
  kind: CredentialKind;
  scopes?: string[];
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

/** A tool as offered to the model, in the engine's provider-neutral shape. */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolCall = { id: string; name: string; arguments: unknown };

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError: boolean };

export type ModelRequest = { system: string; messages: Message[]; tools: ToolDefinition[] };
export type ModelReply = { text: string; toolCalls: ToolCall[] };

export type LedgerRecord = { seq: number; type: string; at: string; prev: string | null } & JsonObject;

/** What a run needs from Stepgate: one model turn at a time, credentials, a ledger sink and limits. */
export type RunContext = {
  model: (request: ModelRequest) => Promise<ModelReply>;
  credentials: (name: string, declaration: CredentialDeclaration) => Promise<string>;
  ledger: (record: LedgerRecord) => void | Promise<void>;
  /** Budgets that depend on the model's context: turns per step, and the longest tool result passed to it. */
  limits: { turnsPerStep: number; toolResultChars: number };
};

export type RunResult = {
  identity: string;
  outputs: Record<string, JsonObject>;
};
