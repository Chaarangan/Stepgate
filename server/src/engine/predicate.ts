import jsonLogic from "json-logic-js";
import { isDeepStrictEqual } from "node:util";
import type { Json, JsonObject } from "./types.ts";

// The operators docs/stepfile.md adds to standard JSONLogic. json-logic-js keeps
// operators in module state, so they are registered once when this module loads.
jsonLogic.add_operation("length", (value: unknown) =>
  Array.isArray(value) ? value.length : typeof value === "string" ? [...value].length : null,
);
jsonLogic.add_operation("unique", (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item, index) => value.findIndex((other) => isDeepStrictEqual(other, item)) === index)
    : null,
);
jsonLogic.add_operation("subset", (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && a.every((item) => b.some((other) => isDeepStrictEqual(other, item))),
);
jsonLogic.add_operation("host", (value: unknown) => {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return null;
  }
  return new URL(value).host.toLowerCase() || null;
});
function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => (current !== null && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), value);
}

// `get` reads one key literally, so a key containing dots (an email address, a domain) still works.
jsonLogic.add_operation("get", (value: unknown, key: unknown) => {
  if (Array.isArray(value) && typeof key === "number") {
    return value[key] ?? null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof key === "string"
    ? ((value as Record<string, unknown>)[key] ?? null)
    : null;
});
// `join` pairs every item of `left` with the first item of `right` whose value at `rightPath` equals the left
// item's value at `leftPath`, so a gate can compare each output row with its evidence row directly.
jsonLogic.add_operation("join", (left: unknown, right: unknown, leftPath: unknown, rightPath: unknown) => {
  if (!Array.isArray(left) || !Array.isArray(right) || typeof leftPath !== "string" || typeof rightPath !== "string") {
    return null;
  }
  return left.map((item: unknown) => ({
    left: item,
    right: right.find((other: unknown) => isDeepStrictEqual(valueAt(other, rightPath), valueAt(item, leftPath))) ?? null,
  }));
});
jsonLogic.add_operation("lower", (value: unknown) => (typeof value === "string" ? value.toLowerCase() : null));
jsonLogic.add_operation("flatten", (value: unknown) =>
  Array.isArray(value) ? value.flatMap((item: unknown) => (Array.isArray(item) ? item : [item])) : null,
);
jsonLogic.add_operation("match_all", (value: unknown, pattern: unknown) => {
  if (typeof value !== "string" || typeof pattern !== "string") {
    return null;
  }
  return [...value.matchAll(new RegExp(pattern, "gu"))].map((match) => match[1] ?? match[0]);
});

/** One tool call a step made, as gates see it: the full result, parsed as JSON where it is JSON. */
export type EvidenceCall = { tool: string; arguments: JsonObject; result: Json; is_error: boolean };

export type PredicateContext = {
  inputs: JsonObject;
  steps: Record<string, JsonObject>;
  output?: Json;
  calls?: EvidenceCall[];
};

/** True only when the rule evaluates to exactly `true`, as docs/stepfile.md specifies. */
export function evaluatePredicate(rule: JsonObject, context: PredicateContext): boolean {
  return jsonLogic.apply(rule, context) === true;
}

/** Every `var` path in a rule, used to check `steps.<id>` references before running. */
export function varPaths(rule: Json): string[] {
  if (Array.isArray(rule)) {
    return rule.flatMap(varPaths);
  }
  if (rule === null || typeof rule !== "object") {
    return [];
  }
  return Object.entries(rule).flatMap(([operator, argument]) => {
    if (operator !== "var") {
      return varPaths(argument);
    }
    const path = Array.isArray(argument) ? argument[0] : argument;
    return typeof path === "string" ? [path] : [];
  });
}
