import type { ToolDeclaration } from "../types.ts";
import { mcpKind } from "./mcp.ts";
import { openApiKind } from "./openapi.ts";
import type { ToolKind } from "./tool.ts";

export const toolKinds: Record<"openapi" | "mcp", ToolKind> = { openapi: openApiKind, mcp: mcpKind };

/** The kind that prepares a declared tool; verifiers are not prepared, because gates call them directly. */
export function kindOf(declaration: ToolDeclaration): ToolKind {
  return declaration.mcp !== undefined ? mcpKind : openApiKind;
}
