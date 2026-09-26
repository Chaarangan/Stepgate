import { PlaceholderUnresolved } from "./errors.ts";
import type { Json, JsonObject } from "./types.ts";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function placeholderPaths(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

function resolvePath(root: Json, path: string): Json | undefined {
  let current: Json | undefined = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || current === undefined) {
      return undefined;
    }
    current = Array.isArray(current) ? current[Number(segment)] : current[segment];
  }
  return current;
}

/** Replaces `{{inputs.x}}` and `{{steps.<id>.x}}`: strings as-is, anything else as indented JSON. */
export function renderInstructions(
  stepId: string,
  text: string,
  context: { inputs: JsonObject; steps: Record<string, JsonObject> },
): string {
  return text.replace(PLACEHOLDER, (_whole, path: string) => {
    const value = resolvePath(context as unknown as Json, path);
    if (value === undefined) {
      throw new PlaceholderUnresolved(stepId, path);
    }
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}
