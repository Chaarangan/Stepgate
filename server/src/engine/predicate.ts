import jsonLogic, { type AdditionalOperation, type RulesLogic } from "json-logic-js";
import { isDeepStrictEqual } from "node:util";
import { linearRegExp } from "./regex.ts";
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
// `difference` is what `subset` found missing: the items of `a` that are not in `b`, which is what an `explain` reports.
jsonLogic.add_operation("difference", (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.filter((item) => !b.some((other) => isDeepStrictEqual(other, item))) : null,
);
// `keys` lists an object's own keys, so a rule can ask which fields an API response left out, as Airtable omits empty ones.
jsonLogic.add_operation("keys", (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : null,
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
  return [...linearRegExp(pattern).matchAll(value)].map((match) => match[1] ?? match[0]);
});

/** One tool call a step made, as gates see it: the full result, parsed as JSON where it is JSON. */
export type EvidenceCall = { tool: string; arguments: JsonObject; result: Json; is_error: boolean };

export type PredicateContext = {
  inputs: JsonObject;
  steps: Record<string, JsonObject>;
  output?: Json;
  calls?: EvidenceCall[];
  /** The step's `let` values, once they are evaluated. */
  let?: JsonObject;
};

/** What a rule evaluates to over some data: a gate's context for `explain`, a tool result for `select`; a literal is itself. */
export function evaluateExpression(rule: Json, data: PredicateContext | Json): Json {
  // json-logic-js returns a literal as is, which its type for a rule does not admit.
  return (jsonLogic.apply(rule as RulesLogic<AdditionalOperation>, data) ?? null) as Json;
}

/** True only when the rule evaluates to exactly `true`, as docs/stepfile.md specifies. */
export function evaluatePredicate(rule: JsonObject, context: PredicateContext): boolean {
  return jsonLogic.apply(rule, context) === true;
}

/** The argument of every use of `operator` in a rule, outermost first. */
export function operatorArguments(rule: Json, operator: string): Json[] {
  if (Array.isArray(rule)) {
    return rule.flatMap((item) => operatorArguments(item, operator));
  }
  if (rule === null || typeof rule !== "object") {
    return [];
  }
  return Object.entries(rule).flatMap(([name, argument]) => [...(name === operator ? [argument] : []), ...operatorArguments(argument, operator)]);
}

/** Every literal pattern given to `match_all` in a rule, checked at load time. */
export function matchAllPatterns(rule: Json): string[] {
  return operatorArguments(rule, "match_all").flatMap((argument) => (Array.isArray(argument) && typeof argument[1] === "string" ? [argument[1]] : []));
}

/** Why a `results` argument is malformed, or null; it must be an operation name and optionally a path, both literal. */
export function resultsProblem(argument: Json): string | null {
  const literal = Array.isArray(argument) && (argument.length === 1 || argument.length === 2) && argument.every((item) => typeof item === "string" && item !== "");
  return literal ? null : `results takes [operation] or [operation, path], as literal strings; got ${JSON.stringify(argument)}`;
}

/**
 * Rewrites every `results` into the filter over `calls` it stands for, so it reads calls wherever `var: calls` does.
 * json-logic-js gives an operator its arguments but not the data, which is why it is expanded rather than registered.
 */
export function expandResults(rule: Json): Json {
  if (Array.isArray(rule)) {
    return rule.map(expandResults);
  }
  if (rule === null || typeof rule !== "object") {
    return rule;
  }
  if (Object.keys(rule).length === 1 && Array.isArray(rule.results)) {
    const [operation, path] = rule.results as [string, string?];
    const successful = { filter: [{ var: "calls" }, { and: [{ "==": [{ var: "tool" }, operation] }, { "!": { var: "is_error" } }] }] };
    return { flatten: { map: [successful, { var: path === undefined ? "result" : `result.${path}` }] } };
  }
  return Object.fromEntries(Object.entries(rule).map(([name, argument]) => [name, expandResults(argument)]));
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
