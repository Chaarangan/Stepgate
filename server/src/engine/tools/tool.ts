import type { HttpContext } from "../http.ts";
import type { CredentialBinding } from "../http.ts";
import type { JsonObject, ToolDeclaration, ToolDefinition } from "../types.ts";

/** What a tool call returns to the step loop. `status` is the HTTP status where there was one. */
export type ToolResult = { content: string; isError: boolean; status: number | null };

/** A declared tool after preflight: the operations it exposes, how to call one, and how to release it. */
export type PreparedTool = {
  definitions: ToolDefinition[];
  call: (name: string, args: JsonObject) => Promise<ToolResult>;
  close: () => Promise<void>;
};

/** What an author asks stepgate_inspect_api for: a filter over the listing, or the full definitions of some operations. */
export type InspectRequest = { kind: "openapi" | "mcp"; url: string; search: string | undefined; operations: string[] | undefined };

/** One kind of remote tool: preparing it for a run, and describing it for an author without credentials. */
export type ToolKind = {
  prepare: (context: HttpContext, toolName: string, declaration: ToolDeclaration, credential: Omit<CredentialBinding, "place"> | null) => Promise<PreparedTool>;
  inspect: (context: HttpContext, url: URL, request: InspectRequest) => Promise<string>;
};

export function matchesSearch(search: string | undefined, ...fields: string[]): boolean {
  return search === undefined || fields.some((field) => field.toLowerCase().includes(search.toLowerCase()));
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
