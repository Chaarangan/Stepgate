import type { RegExpEngine } from "ajv/dist/types/index.js";
import { RE2JS } from "re2js";
import type { Json } from "./types.ts";

/**
 * Compiles an author's pattern with RE2, which matches in time linear in the input, so no pattern a stepfile
 * brings can stall a run on a hostile API response. Lookbehind compiles; lookahead and backreferences do not.
 */
export function linearRegExp(pattern: string): RE2JS {
  return RE2JS.compile(RE2JS.translateRegExp(pattern), RE2JS.LOOKBEHINDS);
}

/** Why RE2 cannot compile the pattern, or null when it can. */
export function patternProblem(pattern: string): string | null {
  try {
    linearRegExp(pattern);
    return null;
  } catch (error) {
    return `pattern ${JSON.stringify(pattern)} is not supported: ${(error as Error).message}; Stepgate runs patterns on RE2, which has no lookahead or backreferences; end a match with a consumed group such as (?:[^0-9]|$) instead`;
  }
}

/** Ajv's hook for its `pattern` and `patternProperties` keywords. The `u` flag is ignored because RE2 always matches code points. */
export const ajvRegExp: RegExpEngine = Object.assign((pattern: string) => linearRegExp(pattern), { code: 'require("re2js").RE2JS' });

/** Every `pattern` and `patternProperties` key in a JSON Schema, for checking at load time. */
export function schemaPatterns(schema: Json): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap(schemaPatterns);
  }
  if (schema === null || typeof schema !== "object") {
    return [];
  }
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(key === "pattern" && typeof value === "string" ? [value] : []),
    ...(key === "patternProperties" && value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []),
    ...schemaPatterns(value),
  ]);
}
