import type { Ajv2020, ValidateFunction } from "ajv/dist/2020.js";
import { ToolCallFailed } from "./errors.ts";
import { guardedFetch, readText, type HttpContext } from "./http.ts";
import { compileWithDefs, describeErrors } from "./json-schema.ts";
import { credentialOf, toolUrl } from "./load.ts";
import { evaluateExpression, evaluatePredicate, expandResults, type PredicateContext } from "./predicate.ts";
import type { Approvals, Gate, Json, JsonObject, JsonSchema, Step, StepfileDocument } from "./types.ts";

const MAX_EXPLANATION = 2_000;

/** What gates see: the run's inputs, earlier outputs, the submission and this step's calls. */
export type GateContext = PredicateContext & { output: Json; calls: NonNullable<PredicateContext["calls"]> };

/** One gate's verdict on one submission. `produces` is the step's output schema, checked before any gate. */
export type GateVerdict = { gate: string; passed: boolean; diagnosis: string | null };

/** A step's verdicts on one submission, and the output they judged: the submission with any derived fields added, or null when it never got that far. */
export type StepCheck = { verdicts: GateVerdict[]; output: JsonObject | null; derived: boolean };

/**
 * A step's gates, compiled once per run. `check` returns a verdict per gate in file order, or only `derive` when the
 * submission holds a derived field, or only `produces` when the output breaks it.
 */
export type StepGates = { check: (context: GateContext) => Promise<StepCheck> };

/** The output schema the client is shown: `produces` without the fields Stepgate derives. */
export function submittedSchema(step: Step): JsonSchema {
  const derived = Object.keys(step.derive ?? {});
  if (derived.length === 0) {
    return step.produces;
  }
  const { properties, required, ...rest } = step.produces as JsonObject & { properties?: JsonObject; required?: string[] };
  return {
    ...rest,
    ...(required === undefined ? {} : { required: required.filter((name) => !derived.includes(name)) }),
    ...(properties === undefined ? {} : { properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !derived.includes(name))) }),
  };
}

function isObject(value: Json): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verdict(gate: string, diagnosis: string | null): GateVerdict {
  return { gate, passed: diagnosis === null, diagnosis };
}

async function askVerifier(document: StepfileDocument, http: HttpContext, step: Step, gateId: string, toolName: string, context: GateContext): Promise<string | null> {
  const tool = document.tools?.[toolName];
  if (tool === undefined) {
    throw new TypeError(`verifier ${toolName} was not declared; load should have rejected this stepfile`);
  }
  const operation = `verifier ${toolName}`;
  const credential = credentialOf(document, toolName);
  // A verifier is posted what docs/stepfile.md lists, which does not include the step's let values.
  const { let: _values, ...shared } = context;
  const body = JSON.stringify({ stepfile: document.id, step: step.id, gate: gateId, ...shared });
  const response = await guardedFetch(
    http,
    operation,
    new URL(toolUrl(tool)),
    { method: "POST", headers: { "content-type": "application/json" }, body },
    credential === null ? null : { ...credential, place: (secret, headers) => headers.set("Authorization", `Bearer ${secret}`) },
  );
  const text = await readText(response, operation);
  if (!response.ok) {
    throw new ToolCallFailed(operation, response.status, text);
  }
  let reply: { pass?: unknown; message?: unknown };
  try {
    reply = JSON.parse(text) as { pass?: unknown; message?: unknown };
  } catch {
    throw new ToolCallFailed(operation, response.status, `response is not JSON: ${text.slice(0, 500)}`);
  }
  if (reply.pass === true) {
    return null;
  }
  if (reply.pass === false) {
    return typeof reply.message === "string" ? reply.message : "verifier returned pass: false";
  }
  throw new ToolCallFailed(operation, response.status, `response has no boolean pass: ${text.slice(0, 500)}`);
}

/** What a failed gate adds to its message; null, an empty string and an empty array add nothing. */
type Detail = (context: GateContext) => Json;

function isEmpty(detail: Json): boolean {
  return detail === null || detail === "" || (Array.isArray(detail) && detail.length === 0);
}

function onlyOperator(rule: Json, operator: string): Json[] | null {
  return rule !== null && typeof rule === "object" && !Array.isArray(rule) && Object.keys(rule).length === 1 && Array.isArray(rule[operator]) ? rule[operator] as Json[] : null;
}

/** The detail a predicate of a known shape gives when it fails, or null when its shape has none (docs/stepfile.md, When a gate fails). */
function automaticDetail(rule: Json): Detail | null {
  const subset = onlyOperator(rule, "subset");
  if (subset !== null && subset.length === 2) {
    return (context) => evaluateExpression({ difference: subset }, context);
  }
  const none = onlyOperator(rule, "none");
  if (none !== null && none.length === 2 && onlyOperator(none[0] ?? null, "join") !== null) {
    return (context) => evaluateExpression({ map: [{ filter: none }, { var: "left" }] }, context);
  }
  const equal = onlyOperator(rule, "==") ?? onlyOperator(rule, "===");
  if (equal !== null && equal.length === 2) {
    const [submitted, expected] = equal as [Json, Json];
    return (context) => `expected ${JSON.stringify(evaluateExpression(expected, context))}, got ${JSON.stringify(evaluateExpression(submitted, context))}`;
  }
  const parts = onlyOperator(rule, "and");
  if (parts !== null) {
    const diagnosable = parts.flatMap((part) => {
      const detail = automaticDetail(part);
      return detail === null ? [] : [{ part: part as JsonObject, detail }];
    });
    if (diagnosable.length === 0) {
      return null;
    }
    return (context) => diagnosable
      .filter(({ part }) => !evaluatePredicate(part, context))
      .map(({ detail }) => detail(context))
      .filter((detail) => !isEmpty(detail))
      .map((detail) => (typeof detail === "string" ? detail : JSON.stringify(detail)))
      .join(" | ");
  }
  return null;
}

/** The message, followed by the detail unless it is empty, cut to a length a model can act on. */
function explained(message: string, detail: Detail | null, context: GateContext): string {
  const value = detail === null ? null : detail(context);
  if (isEmpty(value)) {
    return message;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `${message} ${text.length > MAX_EXPLANATION ? `${text.slice(0, MAX_EXPLANATION)} [cut at ${MAX_EXPLANATION} characters]` : text}`;
}

function compileGate(document: StepfileDocument, services: GateServices, step: Step, gate: Gate, ajv: Ajv2020): (context: GateContext) => Promise<GateVerdict> {
  const defs = document.$defs ?? {};
  if ("schema" in gate) {
    const validate: ValidateFunction = compileWithDefs(ajv, gate.schema, defs);
    return async (context) => verdict(gate.id, validate(context.output) ? null : describeErrors(validate.errors));
  }
  if ("predicate" in gate) {
    const predicate = expandResults(gate.predicate) as JsonObject;
    const explain = gate.explain === undefined ? undefined : expandResults(gate.explain) as JsonObject;
    const detail: Detail | null = explain === undefined ? automaticDetail(predicate) : (context) => evaluateExpression(explain, context);
    return async (context) => verdict(gate.id, evaluatePredicate(predicate, context) ? null : explained(gate.message, detail, context));
  }
  if ("approve" in gate) {
    return async (context) => {
      const { approved, reason } = await services.approvals.ask({ stepfile: document.id, step: step.id, gate: gate.id, message: gate.approve.message, output: context.output });
      return verdict(gate.id, approved ? null : `a person declined to approve this output${reason === null ? "" : `: ${reason}`}`);
    };
  }
  return async (context) => verdict(gate.id, await askVerifier(document, services.http, step, gate.id, gate.http.tool, context));
}

/** What gates reach outside the process: verifiers over HTTP, and people through the client. */
export type GateServices = { http: HttpContext; approvals: Approvals };

/** Compiles the step's output schema and gates against the document's settings-resolved tools. */
export function compileStepGates(document: StepfileDocument, services: GateServices, step: Step, ajv: Ajv2020): StepGates {
  const defs = document.$defs ?? {};
  const validateOutput = compileWithDefs(ajv, step.produces, defs);
  const validateSubmission = step.derive === undefined ? validateOutput : compileWithDefs(ajv, submittedSchema(step), defs);
  const gates = (step.gates ?? []).map((gate) => compileGate(document, services, step, gate, ajv));
  const lets = Object.entries(step.let ?? {}).map(([name, rule]) => [name, expandResults(rule) as JsonObject] as const);
  const derives = Object.entries(step.derive ?? {}).map(([name, rule]) => [name, expandResults(rule) as JsonObject] as const);
  return {
    check: async (submitted) => {
      const refused = isObject(submitted.output) ? derives.map(([name]) => name).filter((name) => Object.hasOwn(submitted.output as JsonObject, name)) : [];
      if (refused.length > 0) {
        const fields = refused.length === 1 ? `${refused[0]} is` : `${refused.join(", ")} are`;
        return { verdicts: [verdict("derive", `${fields} computed by Stepgate; submit the output without ${refused.length === 1 ? "it" : "them"}`)], output: null, derived: false };
      }
      if (!validateSubmission(submitted.output)) {
        return { verdicts: [verdict("produces", describeErrors(validateSubmission.errors))], output: null, derived: false };
      }
      const values = lets.reduce<JsonObject>((earlier, [name, rule]) => ({ ...earlier, [name]: evaluateExpression(rule, { ...submitted, let: earlier }) }), {});
      const output: JsonObject = { ...(submitted.output as JsonObject), ...Object.fromEntries(derives.map(([name, rule]) => [name, evaluateExpression(rule, { ...submitted, let: values })])) };
      if (derives.length > 0 && !validateOutput(output)) {
        return { verdicts: [verdict("produces", `a derived field breaks produces: ${describeErrors(validateOutput.errors)}`)], output: null, derived: true };
      }
      const context = { ...submitted, output, let: values };
      const verdicts: GateVerdict[] = [];
      for (const gate of gates) {
        verdicts.push(await gate(context));
      }
      return { verdicts, output, derived: derives.length > 0 };
    },
  };
}
