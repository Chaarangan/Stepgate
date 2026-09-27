import { parse as parseYaml } from "yaml";
import { CasesInvalid } from "./engine/errors.ts";
import { compileStepGates, type GateVerdict } from "./engine/gates.ts";
import type { HttpContext } from "./engine/http.ts";
import { createValidator, describeErrors } from "./engine/json-schema.ts";
import type { EvidenceCall } from "./engine/predicate.ts";
import type { Approvals, Json, JsonObject, Stepfile } from "./engine/types.ts";

/** One step of a case: the calls it made, what it submitted, and whether every gate should pass or which should fail. */
export type CaseStep = { step: string; calls: EvidenceCall[]; output: Json; expect: "pass" | { fail: string[] } };
export type GateCase = { name: string; inputs: JsonObject; steps: CaseStep[] };

/** A case step's outcome: whether the verdicts matched the expectation, and what ran. */
export type CaseReport = { case: string; step: string; ok: boolean; failed: GateVerdict[]; skipped: string[]; problem: string | null };

const CASES_SCHEMA = {
  type: "object",
  required: ["cases"],
  additionalProperties: false,
  properties: {
    cases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "inputs", "steps"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          inputs: { type: "object" },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["step", "output", "expect"],
              additionalProperties: false,
              properties: {
                step: { type: "string" },
                calls: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["tool", "result"],
                    additionalProperties: false,
                    properties: { tool: { type: "string" }, arguments: { type: "object" }, result: {}, is_error: { type: "boolean" } },
                  },
                },
                output: {},
                expect: {
                  oneOf: [
                    { const: "pass" },
                    { type: "object", required: ["fail"], additionalProperties: false, properties: { fail: { type: "array", minItems: 1, items: { type: "string" } } } },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** Parses a cases file, raising CasesInvalid with every problem, including steps the stepfile does not have. */
export function parseCases(stepfile: Stepfile, text: string): GateCase[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new CasesInvalid([`does not parse as YAML or JSON: ${(error as Error).message}`]);
  }
  const validate = createValidator().compile(CASES_SCHEMA);
  if (!validate(parsed)) {
    throw new CasesInvalid([describeErrors(validate.errors)]);
  }
  const raw = (parsed as { cases: Array<{ name: string; inputs: JsonObject; steps: Array<Omit<CaseStep, "calls"> & { calls?: Array<Partial<EvidenceCall> & { tool: string; result: Json }> }> }> }).cases;
  const known = new Map(stepfile.document.steps.map((step) => [step.id, new Set(step.gates.map((gate) => gate.id))]));
  const problems = raw.flatMap((item) => item.steps.flatMap((step) => {
    const gates = known.get(step.step);
    if (gates === undefined) {
      return [`case "${item.name}": ${step.step} is not a step of ${stepfile.document.id}`];
    }
    const unknown = typeof step.expect === "string" ? [] : step.expect.fail.filter((gate) => gate !== "produces" && !gates.has(gate));
    return unknown.map((gate) => `case "${item.name}", step ${step.step}: ${gate} is not one of its gates`);
  }));
  if (problems.length > 0) {
    throw new CasesInvalid(problems);
  }
  return raw.map((item) => ({
    ...item,
    steps: item.steps.map((step) => ({
      ...step,
      calls: (step.calls ?? []).map((call) => ({ tool: call.tool, arguments: call.arguments ?? {}, result: call.result, is_error: call.is_error ?? false })),
    })),
  }));
}

// Offline gates never make a request, so any attempt is refused as undeclared egress.
const OFFLINE: HttpContext = {
  allowedHosts: new Set(),
  append: async () => undefined,
  userAgent: "stepgate offline gate test",
  credentials: { value: async () => "", rejected: async () => false },
  limits: { requestTimeoutMs: 1, responseBytes: 1 },
};

const NO_PEOPLE: Approvals = {
  available: false,
  ask: async (request) => {
    throw new TypeError(`approve gate ${request.gate} reached an offline test, which skips approve gates`);
  },
};

/**
 * Runs each case's steps through the stepfile's own gates with the recorded calls, no network and no model.
 * A step's output joins `steps` for later ones when it is expected to pass. Verifier and approve gates are skipped and named.
 */
export async function testGates(stepfile: Stepfile, cases: GateCase[]): Promise<CaseReport[]> {
  const ajv = createValidator();
  const reports: CaseReport[] = [];
  for (const item of cases) {
    const accepted: Record<string, JsonObject> = {};
    for (const caseStep of item.steps) {
      const step = stepfile.document.steps.find((candidate) => candidate.id === caseStep.step);
      if (step === undefined) {
        throw new TypeError(`step ${caseStep.step} vanished after parseCases checked it`);
      }
      const offline = step.gates.filter((gate) => !("http" in gate) && !("approve" in gate));
      const skipped = step.gates.filter((gate) => "http" in gate || "approve" in gate).map((gate) => gate.id);
      const verdicts = await compileStepGates(stepfile.document, { http: OFFLINE, approvals: NO_PEOPLE }, { ...step, gates: offline }, ajv)
        .check({ inputs: item.inputs, steps: accepted, output: caseStep.output, calls: caseStep.calls });
      const failed = verdicts.filter((verdict) => !verdict.passed);
      const expected = caseStep.expect === "pass" ? [] : [...caseStep.expect.fail].sort();
      const actual = failed.map((verdict) => verdict.gate).sort();
      const ok = JSON.stringify(expected) === JSON.stringify(actual);
      reports.push({
        case: item.name,
        step: step.id,
        ok,
        failed,
        skipped,
        problem: ok ? null : `expected ${expected.length === 0 ? "every gate to pass" : `${expected.join(", ")} to fail`}, but ${actual.length === 0 ? "every gate passed" : `${actual.join(", ")} failed`}`,
      });
      if (caseStep.expect === "pass") {
        accepted[step.id] = caseStep.output as JsonObject;
      }
    }
  }
  return reports;
}
