import type { Ajv2020, ValidateFunction } from "ajv/dist/2020.js";
import { ToolCallFailed } from "./errors.ts";
import { guardedFetch, readText, type HttpContext } from "./http.ts";
import { compileWithDefs, describeErrors } from "./json-schema.ts";
import { credentialOf, toolUrl } from "./load.ts";
import { evaluateExpression, evaluatePredicate, type PredicateContext } from "./predicate.ts";
import type { Gate, Json, JsonObject, Step, StepfileDocument } from "./types.ts";

const MAX_EXPLANATION = 2_000;

/** What gates see: the run's inputs, earlier outputs, the submission and this step's calls. */
export type GateContext = PredicateContext & { output: Json; calls: NonNullable<PredicateContext["calls"]> };

/** One gate's verdict on one submission. `produces` is the step's output schema, checked before any gate. */
export type GateVerdict = { gate: string; passed: boolean; diagnosis: string | null };

/** A step's gates, compiled once per run. `check` returns a verdict per gate in file order, or only `produces` when the output breaks it. */
export type StepGates = { check: (context: GateContext) => Promise<GateVerdict[]> };

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
  const body = JSON.stringify({ stepfile: document.id, step: step.id, gate: gateId, ...context });
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

/** The message, followed by what `explain` evaluates to unless that is null or empty, cut to a length a model can act on. */
function explained(message: string, explain: JsonObject | undefined, context: GateContext): string {
  const detail = explain === undefined ? null : evaluateExpression(explain, context);
  if (detail === null || (Array.isArray(detail) && detail.length === 0) || detail === "") {
    return message;
  }
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return `${message} ${text.length > MAX_EXPLANATION ? `${text.slice(0, MAX_EXPLANATION)} [cut at ${MAX_EXPLANATION} characters]` : text}`;
}

function compileGate(document: StepfileDocument, http: HttpContext, step: Step, gate: Gate, ajv: Ajv2020): (context: GateContext) => Promise<GateVerdict> {
  const defs = document.$defs ?? {};
  if ("schema" in gate) {
    const validate: ValidateFunction = compileWithDefs(ajv, gate.schema, defs);
    return async (context) => verdict(gate.id, validate(context.output) ? null : describeErrors(validate.errors));
  }
  if ("predicate" in gate) {
    return async (context) => verdict(gate.id, evaluatePredicate(gate.predicate, context) ? null : explained(gate.message, gate.explain, context));
  }
  return async (context) => verdict(gate.id, await askVerifier(document, http, step, gate.id, gate.http.tool, context));
}

/** Compiles the step's output schema and gates against the document's settings-resolved tools. */
export function compileStepGates(document: StepfileDocument, http: HttpContext, step: Step, ajv: Ajv2020): StepGates {
  const validateOutput = compileWithDefs(ajv, step.produces, document.$defs ?? {});
  const gates = step.gates.map((gate) => compileGate(document, http, step, gate, ajv));
  return {
    check: async (context) => {
      if (!validateOutput(context.output)) {
        return [verdict("produces", describeErrors(validateOutput.errors))];
      }
      const verdicts: GateVerdict[] = [];
      for (const gate of gates) {
        verdicts.push(await gate(context));
      }
      return verdicts;
    },
  };
}
