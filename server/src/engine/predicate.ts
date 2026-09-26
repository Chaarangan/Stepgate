import jsonLogic from "json-logic-js";
import { isDeepStrictEqual } from "node:util";
import type { Json, JsonObject } from "./types.ts";

// The five operators docs/stepfile.md adds to standard JSONLogic. json-logic-js keeps
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
jsonLogic.add_operation("match_all", (value: unknown, pattern: unknown) => {
  if (typeof value !== "string" || typeof pattern !== "string") {
    return null;
  }
  return [...value.matchAll(new RegExp(pattern, "gu"))].map((match) => match[1] ?? match[0]);
});

export type PredicateContext = {
  inputs: JsonObject;
  steps: Record<string, JsonObject>;
  output?: Json;
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
