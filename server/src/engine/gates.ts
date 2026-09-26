import type { Ajv2020 } from "ajv/dist/2020.js";
import { ToolCallFailed } from "./errors.ts";
import type { GateDiagnosis } from "./errors.ts";
import { guardedFetch, type CredentialBinding, type HttpContext } from "./http.ts";
import { compileWithDefs, describeErrors } from "./json-schema.ts";
import { toolUrl } from "./load.ts";
import { evaluatePredicate, type PredicateContext } from "./predicate.ts";
import type { Json, StepfileDocument, Step } from "./types.ts";

export type GateInput = {
  document: StepfileDocument;
  step: Step;
  context: PredicateContext & { output: Json };
  ajv: Ajv2020;
  http: HttpContext;
  verifierCredential: (toolName: string) => Omit<CredentialBinding, "place"> | null;
};

async function runHttpGate(input: GateInput, gateId: string, toolName: string): Promise<string | null> {
  const tool = input.document.tools?.[toolName];
  if (tool === undefined) {
    throw new TypeError(`verifier ${toolName} was not declared; load should have rejected this stepfile`);
  }
  const credential = input.verifierCredential(toolName);
  const body = JSON.stringify({ stepfile: input.document.id, step: input.step.id, gate: gateId, ...input.context });
  const response = await guardedFetch(
    input.http,
    `verifier ${toolName}`,
    new URL(toolUrl(tool)),
    { method: "POST", headers: { "content-type": "application/json" }, body },
    credential === null ? null : { ...credential, place: (secret, headers) => headers.set("Authorization", `Bearer ${secret}`) },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new ToolCallFailed(`verifier ${toolName}`, response.status, text);
  }
  const verdict = JSON.parse(text) as { pass?: unknown; message?: unknown };
  if (verdict.pass === true) {
    return null;
  }
  if (verdict.pass === false) {
    return typeof verdict.message === "string" ? verdict.message : "verifier returned pass: false";
  }
  throw new ToolCallFailed(`verifier ${toolName}`, response.status, `response has no boolean pass: ${text.slice(0, 500)}`);
}

/** Validates the submission against `produces`, then runs every gate. Returns the failures, empty when all pass. */
export async function evaluateGates(input: GateInput): Promise<GateDiagnosis[]> {
  const defs = input.document.$defs ?? {};
  const validateOutput = compileWithDefs(input.ajv, input.step.produces, defs);
  if (!validateOutput(input.context.output)) {
    return [{ gate: "produces", diagnosis: describeErrors(validateOutput.errors) }];
  }
  const failures: GateDiagnosis[] = [];
  for (const gate of input.step.gates) {
    if ("schema" in gate) {
      const validate = compileWithDefs(input.ajv, gate.schema, defs);
      if (!validate(input.context.output)) {
        failures.push({ gate: gate.id, diagnosis: describeErrors(validate.errors) });
      }
    } else if ("predicate" in gate) {
      if (!evaluatePredicate(gate.predicate, input.context)) {
        failures.push({ gate: gate.id, diagnosis: gate.message });
      }
    } else {
      const diagnosis = await runHttpGate(input, gate.id, gate.http.tool);
      if (diagnosis !== null) {
        failures.push({ gate: gate.id, diagnosis });
      }
    }
  }
  return failures;
}
