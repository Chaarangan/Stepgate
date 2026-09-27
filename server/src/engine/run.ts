import type { ValidateFunction } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import {
  CallLimitReached,
  CredentialUnavailable,
  GateFailed,
  InvalidGrant,
  PreflightFailed,
  RunNotActive,
  type GateDiagnosis,
} from "./errors.ts";
import { compileStepGates, type StepGates } from "./gates.ts";
import type { HttpContext } from "./http.ts";
import { canonicalHash, textHash } from "./identity.ts";
import { compileToolSchema, createToolSchemaValidators, createValidator, describeErrors, inlineLocalRefs } from "./json-schema.ts";
import { createLedger, type AppendRecord } from "./ledger.ts";
import { credentialOf, declaredToolHost } from "./load.ts";
import { renderInstructions } from "./placeholders.ts";
import { evaluatePredicate, type EvidenceCall } from "./predicate.ts";
import { resolveSettings } from "./settings.ts";
import { kindOf } from "./tools/kinds.ts";
import type { ToolResult } from "./tools/tool.ts";
import type { Json, JsonObject, JsonSchema, RunContext, RunResult, Stepfile, Step, ToolDefinition } from "./types.ts";

type StepOperation = {
  definition: ToolDefinition;
  validateArgs: ValidateFunction;
  toolName: string;
  host: string;
  credential: string | null;
  call: (args: JsonObject) => Promise<ToolResult>;
};

type Prepared = {
  tools: Map<string, StepOperation>;
  close: () => Promise<void>;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function checkCredentials(stepfile: Stepfile, runContext: RunContext): Promise<void> {
  for (const [name, declaration] of Object.entries(stepfile.document.credentials ?? {})) {
    try {
      const value = await runContext.credentials(name, declaration);
      if (declaration.kind === "basic" && !value.includes(":")) {
        throw new PreflightFailed(`credential ${name}`, "a basic credential must be user:secret, for example you@example.com:api-token");
      }
    } catch (error) {
      if (error instanceof CredentialUnavailable || error instanceof InvalidGrant) {
        throw new PreflightFailed(`credential ${name}`, error.message, { cause: error });
      }
      throw error;
    }
  }
}

/** Resolves every credential and connects every tool before step 1 (docs/how-it-works.md, Preflight). */
async function preflight(stepfile: Stepfile, inputs: JsonObject, runContext: RunContext, http: HttpContext): Promise<Prepared> {
  const ajv = createValidator();
  const validateInputs = ajv.compile(stepfile.document.inputs);
  if (!validateInputs(inputs)) {
    throw new PreflightFailed("inputs", describeErrors(validateInputs.errors));
  }
  await checkCredentials(stepfile, runContext);
  const toolSchemas = createToolSchemaValidators();

  const tools = new Map<string, StepOperation>();
  const closers: Array<() => Promise<void>> = [];
  const close = async () => {
    await Promise.all(closers.map((closer) => closer()));
  };
  try {
    for (const [toolName, declaration] of Object.entries(stepfile.document.tools ?? {})) {
      if (declaration.verifier !== undefined) {
        continue;
      }
      const credential = credentialOf(stepfile.document, toolName);
      const prepared = await kindOf(declaration).prepare(http, toolName, declaration, credential);
      closers.push(prepared.close);
      for (const definition of prepared.definitions) {
        let validateArgs: ValidateFunction;
        try {
          validateArgs = compileToolSchema(toolSchemas, definition.inputSchema);
        } catch (error) {
          throw new PreflightFailed(`tool ${toolName}`, `input schema of ${definition.name} does not compile: ${(error as Error).message}`);
        }
        tools.set(definition.name, {
          definition,
          validateArgs,
          toolName,
          host: declaredToolHost(declaration),
          credential: credential?.name ?? null,
          call: (args) => prepared.call(definition.name, args),
        });
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { tools, close };
}


function truncate(content: string, limit: number): string {
  return content.length <= limit
    ? content
    : `${content.slice(0, limit)}\n[truncated: the result was ${content.length} characters; only the first ${limit} are shown]`;
}

function parseResult(content: string): Json {
  try {
    return JSON.parse(content) as Json;
  } catch {
    // Not JSON: gates see the text itself, which is what the tool returned.
    return content;
  }
}

/** Runs one tool call. `evidence` is what gates see; it is null when the call never reached the tool. */
async function callTool(prepared: StepOperation, operation: string, args: Json | undefined, stepId: string, append: AppendRecord, limit: number): Promise<{ shown: ToolResult; evidence: EvidenceCall | null }> {
  if (!isObject(args) || !prepared.validateArgs(args)) {
    return { shown: { content: `Invalid arguments for ${operation}: ${describeErrors(prepared.validateArgs.errors) || "arguments must be an object"}`, isError: true, status: null }, evidence: null };
  }
  const started = performance.now();
  const result = await prepared.call(args);
  await append("tool_call", {
    step: stepId,
    tool: prepared.toolName,
    operation,
    host: prepared.host,
    status: result.status,
    is_error: result.isError,
    duration_ms: Math.round(performance.now() - started),
    credential: prepared.credential,
    response: { sha256: textHash(result.content), length: result.content.length },
    truncated_to: result.content.length > limit ? limit : null,
  });
  return {
    shown: { ...result, content: truncate(result.content, limit) },
    evidence: { tool: operation, arguments: args, result: parseResult(result.content), is_error: result.isError },
  };
}

/** What the client is shown of the step it is on; it never sees another step. */
export type StepView = {
  step: string;
  number: number;
  total: number;
  instructions: string;
  operations: ToolDefinition[];
  produces: JsonSchema;
  attempts_left: number;
};

export type Progress =
  | { state: "step"; step: StepView }
  | { state: "rejected"; failures: GateDiagnosis[]; attempts_left: number }
  | { state: "finished"; result: RunResult };

/** A run in progress. Every method raises once the run has ended, and a raised StepgateError ends it. */
export type Run = {
  id: string;
  call: (operation: string, args: Json | undefined) => Promise<ToolResult>;
  submit: (output: Json | undefined) => Promise<Progress>;
  /** Ends a run the client stopped driving, closing its tool connections. */
  abandon: () => Promise<void>;
};

type Current = {
  step: Step;
  index: number;
  allowed: Map<string, StepOperation>;
  instructions: string;
  attempt: number;
  callsMade: number;
  calls: EvidenceCall[];
};

/** Preflights and opens step 1; the client then drives each step with `call` and `submit`. */
export async function startRun(written: Stepfile, inputs: JsonObject, runContext: RunContext): Promise<{ run: Run; progress: Progress }> {
  const id = randomUUID();
  const append = createLedger(runContext.ledger);
  await append("run_started", { run: id, stepfile: written.document.id, identity: written.identity, inputs: canonicalHash(inputs) });
  let prepared: Prepared | undefined;
  let ended = false;
  const end = async (type: string, fields: JsonObject) => {
    ended = true;
    await append(type, fields);
    await prepared?.close();
  };
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (ended) {
      throw new RunNotActive(id);
    }
    try {
      return await work();
    } catch (error) {
      if (!ended) {
        await end("run_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
      throw error;
    }
  };
  // One operation at a time, so parallel calls from a client cannot interleave a step's evidence or ledger.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => guarded(work));
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const session = await guarded(async () => {
    // Settings are filled in first, so the host allowlist below only ever holds concrete hosts.
    const stepfile: Stepfile = { ...written, document: await resolveSettings(written.document, runContext) };
    const http: HttpContext = { allowedHosts: new Set(Object.values(stepfile.document.tools ?? {}).map(declaredToolHost)), append, userAgent: runContext.userAgent, credentials: runContext.credentials, limits: runContext.limits };
    prepared = await preflight(stepfile, inputs, runContext, http);
    const ajv = createValidator();
    const gates = new Map<string, StepGates>(stepfile.document.steps.map((step) => [step.id, compileStepGates(stepfile.document, http, step, ajv)]));
    return { stepfile, tools: prepared.tools, gates };
  });
  const steps = session.stepfile.document.steps;
  const defs = { $defs: { ...(session.stepfile.document.$defs ?? {}) } };
  const outputs: Record<string, JsonObject> = {};
  let current: Current | null = null;

  const view = (open: Current): StepView => ({
    step: open.step.id,
    number: open.index + 1,
    total: steps.length,
    instructions: open.instructions,
    operations: [...open.allowed.values()].map((tool) => tool.definition),
    produces: inlineLocalRefs(open.step.produces, defs, []) as JsonObject,
    attempts_left: (open.step.retries ?? 0) + 2 - open.attempt,
  });

  const advance = async (from: number): Promise<Progress> => {
    for (let index = from; index < steps.length; index += 1) {
      const step = steps[index] as Step;
      if (step.when !== undefined && !evaluatePredicate(step.when, { inputs, steps: outputs })) {
        await append("step_skipped", { step: step.id });
        continue;
      }
      const allowed = new Map((step.tools ?? []).flatMap((name) => {
        const tool = session.tools.get(name);
        return tool === undefined ? [] : [[name, tool] as const];
      }));
      const instructions = renderInstructions(step.id, step.instructions, { inputs, steps: outputs });
      await append("step_started", { step: step.id });
      current = { step, index, allowed, instructions, attempt: 1, callsMade: 0, calls: [] };
      return { state: "step", step: view(current) };
    }
    current = null;
    await end("run_finished", { outcome: "passed" });
    return { state: "finished", result: { identity: written.identity, outputs } };
  };

  const progress = await guarded(() => advance(0));

  const run: Run = {
    id,
    call: (operation, args) => serial(async () => {
      const open = current as Current;
      if (open.callsMade >= runContext.limits.callsPerStep) {
        throw new CallLimitReached(open.step.id, runContext.limits.callsPerStep);
      }
      open.callsMade += 1;
      const tool = open.allowed.get(operation);
      if (tool === undefined) {
        await append("tool_refused", { step: open.step.id, operation });
        return { content: `${operation} is not available in this step.`, isError: true, status: null };
      }
      const { shown, evidence } = await callTool(tool, operation, args ?? {}, open.step.id, append, runContext.limits.toolResultChars);
      if (evidence !== null) {
        open.calls = [...open.calls, evidence];
      }
      return shown;
    }),
    submit: (output) => serial(async () => {
      const open = current as Current;
      const { step, attempt } = open;
      await append("submit", { step: step.id, attempt, output: { sha256: canonicalHash(output ?? null), length: JSON.stringify(output ?? null).length } });
      const verdicts = await (session.gates.get(step.id) as StepGates).check({ inputs, steps: outputs, output: output ?? null, calls: open.calls });
      for (const { gate, passed, diagnosis } of verdicts) {
        await append("gate", { step: step.id, attempt, gate, verdict: passed ? "pass" : "fail", diagnosis: diagnosis === null ? null : textHash(diagnosis) });
      }
      const failures = verdicts.flatMap(({ gate, passed, diagnosis }) => (passed ? [] : [{ gate, diagnosis: diagnosis ?? "" }]));
      if (failures.length === 0) {
        await append("step_passed", { step: step.id, attempt });
        outputs[step.id] = output as JsonObject;
        return advance(open.index + 1);
      }
      if (attempt > (step.retries ?? 0)) {
        throw new GateFailed(step.id, failures);
      }
      open.attempt += 1;
      return { state: "rejected", failures, attempts_left: view(open).attempts_left };
    }),
    abandon: async () => {
      if (!ended) {
        await end("run_abandoned", {});
      }
    },
  };
  return { run, progress };
}
