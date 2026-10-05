import jsonLogic, { type AdditionalOperation, type RulesLogic } from "json-logic-js";
import { isDeepStrictEqual } from "node:util";
import { linearRegExp } from "./regex.ts";
import type { EvidenceCall, Json, JsonObject } from "./types.ts";

// The operators docs/stepfile.md adds to standard JSONLogic. json-logic-js keeps
// operators in module state, so they are registered once when this module loads.
const STEPGATE_OPERATORS: string[] = [];
function register(name: string, operation: (...args: never[]) => unknown): void {
  STEPGATE_OPERATORS.push(name);
  jsonLogic.add_operation(name, operation);
}

register("length", (value: unknown) =>
  Array.isArray(value) ? value.length : typeof value === "string" ? [...value].length : null,
);
register("unique", (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item, index) => value.findIndex((other) => isDeepStrictEqual(other, item)) === index)
    : null,
);
register("subset", (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && a.every((item) => b.some((other) => isDeepStrictEqual(other, item))),
);
// `difference` is what `subset` found missing: the items of `a` that are not in `b`, which is what an `explain` reports.
register("difference", (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.filter((item) => !b.some((other) => isDeepStrictEqual(other, item))) : null,
);
// `keys` lists an object's own keys, so a rule can ask which fields an API response left out, as Airtable omits empty ones.
register("keys", (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : null,
);
register("host", (value: unknown) => {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return null;
  }
  return new URL(value).host.toLowerCase() || null;
});
function valueAt(value: unknown, path: string): unknown {
  if (path === "") {
    return value;
  }
  return path.split(".").reduce<unknown>((current, segment) => (current !== null && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), value);
}

function compareStringsByCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const iterA = a[Symbol.iterator]();
  const iterB = b[Symbol.iterator]();
  while (true) {
    const nextA = iterA.next();
    const nextB = iterB.next();
    if (nextA.done && nextB.done) {
      return 0;
    }
    if (nextA.done) {
      return -1;
    }
    if (nextB.done) {
      return 1;
    }
    const cpA = nextA.value.codePointAt(0)!;
    const cpB = nextB.value.codePointAt(0)!;
    if (cpA !== cpB) {
      return cpA < cpB ? -1 : 1;
    }
  }
}

function compareValues(valA: unknown, valB: unknown): number {
  if (typeof valA === "number" && typeof valB === "number") {
    if (Number.isNaN(valA) && Number.isNaN(valB)) {
      return 0;
    }
    if (Number.isNaN(valA)) {
      return 1;
    }
    if (Number.isNaN(valB)) {
      return -1;
    }
    return valA < valB ? -1 : valA > valB ? 1 : 0;
  }
  if (typeof valA === "string" && typeof valB === "string") {
    return compareStringsByCodePoint(valA, valB);
  }
  if (typeof valA === "boolean" && typeof valB === "boolean") {
    return valA === valB ? 0 : valA ? 1 : -1;
  }
  const strA = String(valA);
  const strB = String(valB);
  return compareStringsByCodePoint(strA, strB);
}

// `get` reads one key literally, so a key containing dots (an email address, a domain) still works.
register("get", (value: unknown, key: unknown) => {
  if (Array.isArray(value) && typeof key === "number") {
    return value[key] ?? null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof key === "string"
    ? ((value as Record<string, unknown>)[key] ?? null)
    : null;
});
// `join` pairs every item of `left` with the first item of `right` whose value at `rightPath` equals the left
// item's value at `leftPath`, so a gate can compare each output row with its evidence row directly.
register("join", (left: unknown, right: unknown, leftPath: unknown, rightPath: unknown) => {
  if (!Array.isArray(left) || !Array.isArray(right) || typeof leftPath !== "string" || typeof rightPath !== "string") {
    return null;
  }
  return left.map((item: unknown) => ({
    left: item,
    right: right.find((other: unknown) => isDeepStrictEqual(valueAt(other, rightPath), valueAt(item, leftPath))) ?? null,
  }));
});
// `object` builds an object from [key, value] pairs, because JSONLogic keeps an object literal as data, unevaluated.
register("object", (...pairs: unknown[]) =>
  pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string") ? Object.fromEntries(pairs as Array<[string, unknown]>) : null,
);
// `assign` merges objects in sequence, later ones overriding earlier ones,
// so a step can extend an existing object without re-listing every field.
register("assign", (...objects: unknown[]) =>
  objects.length > 0 &&
  objects.every((obj) => obj !== null && typeof obj === "object" && !Array.isArray(obj))
    ? Object.assign({}, ...objects)
    : null,
);
register("lower", (value: unknown) => (typeof value === "string" ? value.toLowerCase() : null));
register("flatten", (value: unknown) =>
  Array.isArray(value) ? value.flatMap((item: unknown) => (Array.isArray(item) ? item : [item])) : null,
);
register("match_all", (value: unknown, pattern: unknown) => {
  if (typeof value !== "string" || typeof pattern !== "string") {
    return null;
  }
  return [...linearRegExp(pattern).matchAll(value)].map((match) => match[1] ?? match[0]);
});
// `sort_by` returns the array ordered by the value at `path` in each item.
// Stable, compares numbers as numbers and strings by code point, and puts null last.
register("sort_by", (array: unknown, path: unknown, direction: unknown) => {
  if (!Array.isArray(array) || typeof path !== "string") {
    return null;
  }
  const dir = typeof direction === "string" ? direction.toLowerCase() : "";
  if (dir !== "asc" && dir !== "desc") {
    return null;
  }
  const indexed = array.map((item, index) => ({ item, index }));
  indexed.sort((a, b) => {
    const valA = valueAt(a.item, path);
    const valB = valueAt(b.item, path);
    const aNull = valA === null || valA === undefined;
    const bNull = valB === null || valB === undefined;
    if (aNull && bNull) {
      return a.index - b.index;
    }
    if (aNull) {
      return 1;
    }
    if (bNull) {
      return -1;
    }
    const diff = compareValues(valA, valB);
    if (diff !== 0) {
      return dir === "desc" ? -diff : diff;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.item);
});

// json-logic-js 2.0's operators and special forms; it does not export the list.
const JSONLOGIC_OPERATORS = [
  "==", "===", "!=", "!==", ">", ">=", "<", "<=", "!!", "!", "%", "log", "in", "cat", "substr", "+", "*", "-", "/", "min", "max", "merge",
  "var", "missing", "missing_some", "method", "if", "?:", "and", "or", "filter", "map", "reduce", "all", "none", "some",
];
const OPERATORS = new Set([...JSONLOGIC_OPERATORS, ...STEPGATE_OPERATORS]);

/** Why each part of a rule would not evaluate as written: an object that JSONLogic would keep as data, or an unknown operator. */
export function expressionProblems(rule: Json): string[] {
  if (Array.isArray(rule)) {
    return rule.flatMap(expressionProblems);
  }
  if (rule === null || typeof rule !== "object") {
    return [];
  }
  const keys = Object.keys(rule);
  // An empty object is data by any reading, such as the start of a reduce, so it is not a mistake to report.
  if (keys.length === 0) {
    return [];
  }
  if (keys.length !== 1) {
    return [`an expression holds an object with keys ${keys.join(", ")}, which JSONLogic keeps as data; build it with object`];
  }
  const operator = keys[0] as string;
  // results is expanded into standard operators before evaluation, so it is never registered.
  if (!OPERATORS.has(operator) && operator !== "results") {
    return [`${operator} is not a JSONLogic or Stepgate operator`];
  }
  return expressionProblems(rule[operator] ?? null);
}

/** Why each expression in a template would not evaluate as written; see `evaluateTemplate` for what counts as one. */
export function templateProblems(template: Json): string[] {
  if (Array.isArray(template)) {
    return template.flatMap(templateProblems);
  }
  if (template === null || typeof template !== "object") {
    return [];
  }
  const keys = Object.keys(template);
  if (keys.length === 1 && keys[0] === "literal") {
    return [];
  }
  if (keys.length === 1 && OPERATORS.has(keys[0] ?? "")) {
    return expressionProblems(template);
  }
  return Object.values(template).flatMap(templateProblems);
}

/**
 * Evaluates a template: a one-key object naming an operator is an expression, `{ literal: x }` is x as written, any
 * other object or array has each member evaluated, and a scalar is itself (docs/stepfile.md, Mechanical steps).
 */
export function evaluateTemplate(template: Json, data: Json | PredicateContext): Json {
  if (Array.isArray(template)) {
    return template.map((item) => evaluateTemplate(item, data));
  }
  if (template === null || typeof template !== "object") {
    return template;
  }
  const keys = Object.keys(template);
  if (keys.length === 1 && keys[0] === "literal") {
    return template.literal ?? null;
  }
  if (keys.length === 1 && OPERATORS.has(keys[0] ?? "")) {
    return evaluateExpression(template, data);
  }
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, evaluateTemplate(value, data)]));
}


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
