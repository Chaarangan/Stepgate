import type { ValidateFunction } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import {
  AuthorizationFailed,
  CallArgumentsInvalid,
  CallLimitReached,
  CredentialUnavailable,
  EgressDenied,
  GateFailed,
  InvalidGrant,
  PreflightFailed,
  RunNotActive,
  ToolCallFailed,
  type GateDiagnosis,
} from "./errors.ts";
import { compileStepGates, submittedSchema, type StepGates } from "./gates.ts";
import { guardedFetch, type HttpContext } from "./http.ts";
import { discoverMcpAuthorization, tokenEndpointProblem, type McpAuthorization } from "./mcp-auth.ts";
import { canonicalHash, textHash } from "./identity.ts";
import { compileToolSchema, createToolSchemaValidators, createValidator, describeErrors, inlineLocalRefs } from "./json-schema.ts";
import { createLedger, type AppendRecord } from "./ledger.ts";
import { credentialOf, declaredToolHost } from "./load.ts";
import { renderInstructions } from "./placeholders.ts";
import { evaluateExpression, evaluatePredicate, evaluateTemplate, type EvidenceCall } from "./predicate.ts";
import { resolveSettings } from "./settings.ts";
import { kindOf } from "./tools/kinds.ts";
import type { ToolResult } from "./tools/tool.ts";
import type { Json, JsonObject, JsonSchema, MechanicalWork, RecordedStep, RunContext, RunResult, Stepfile, Step, ToolDefinition } from "./types.ts";

type StepOperation = {
  definition: ToolDefinition;
  validateArgs: ValidateFunction;
  toolName: string;
  host: string;
  credential: string | null;
  /** What the client is shown of the result, when the stepfile narrows it; gates always see the whole result. */
  select: JsonObject | null;
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
      const value = await runContext.credentials.value(name, declaration);
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

/**
 * Refuses a refresh token's destination the MCP server does not vouch for: when the server uses MCP authorization,
 * its authorization server's token endpoint must be the credential's token_url.
 */
async function checkTokenEndpoint(http: HttpContext, toolName: string, serverUrl: string, credential: string, tokenUrl: string): Promise<void> {
  const operation = `discover authorization for tool ${toolName}`;
  const context: HttpContext = { ...http, allowedHosts: new Set([...http.allowedHosts, new URL(tokenUrl).host]) };
  let found: McpAuthorization | null;
  try {
    found = await discoverMcpAuthorization((url, init) => guardedFetch(context, operation, new URL(url), init ?? {}, null), serverUrl);
  } catch (error) {
    // EgressDenied here means the authorization server is on neither the tool's host nor token_url's.
    if (error instanceof AuthorizationFailed || error instanceof EgressDenied) {
      throw new PreflightFailed(`credential ${credential}`, error.message, { cause: error });
    }
    throw error;
  }
  const problem = found === null ? null : tokenEndpointProblem(found, tokenUrl);
  if (problem !== null) {
    throw new PreflightFailed(`credential ${credential}`, problem);
  }
}

/** Resolves every credential and connects every tool before step 1 (docs/how-it-works.md, Preflight). */
async function preflight(stepfile: Stepfile, inputs: JsonObject, runContext: RunContext, http: HttpContext): Promise<Prepared> {
  const ajv = createValidator();
  const validateInputs = ajv.compile(stepfile.document.inputs);
  if (!validateInputs(inputs)) {
    throw new PreflightFailed("inputs", describeErrors(validateInputs.errors));
  }
  // Before any credential is read, since reading a refreshable one sends its refresh token to token_url.
  for (const [toolName, declaration] of Object.entries(stepfile.document.tools ?? {})) {
    const credential = credentialOf(stepfile.document, toolName);
    if (declaration.mcp !== undefined && credential?.declaration.token_url !== undefined) {
      await checkTokenEndpoint(http, toolName, declaration.mcp.url, credential.name, credential.declaration.token_url);
    }
  }
  await checkCredentials(stepfile, runContext);
  if (!runContext.approvals.available && stepfile.document.steps.some((step) => (step.gates ?? []).some((gate) => "approve" in gate))) {
    throw new PreflightFailed("approval", "the stepfile has approve gates, which ask a person through MCP elicitation, and this client does not support elicitation");
  }
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
        const exposed = (declaration.exposes ?? []).find((entry) => typeof entry !== "string" && entry.name === definition.name);
        tools.set(definition.name, {
          definition,
          select: typeof exposed === "object" ? exposed.select ?? null : null,
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

/** Who made a call: the client through stepgate_call, or Stepgate for a mechanical step's call of this id. */
type Caller = { by: "client" } | { by: "stepgate"; call: string };

/** Runs one tool call. `evidence` is what gates see; it is null when the call never reached the tool. */
async function callTool(prepared: StepOperation, operation: string, args: Json | undefined, stepId: string, caller: Caller, append: AppendRecord, limit: number): Promise<{ shown: ToolResult; evidence: EvidenceCall | null }> {
  if (!isObject(args) || !prepared.validateArgs(args)) {
    return { shown: { content: `Invalid arguments for ${operation}: ${describeErrors(prepared.validateArgs.errors) || "arguments must be an object"}`, isError: true, status: null }, evidence: null };
  }
  const started = performance.now();
  const result = await prepared.call(args);
  // An error result is shown whole, so the client can see what went wrong.
  const shown = prepared.select === null || result.isError ? result.content : JSON.stringify(evaluateExpression(prepared.select, parseResult(result.content)));
  await append("tool_call", {
    step: stepId,
    caller: caller.by,
    ...(caller.by === "stepgate" ? { call: caller.call } : {}),
    tool: prepared.toolName,
    operation,
    host: prepared.host,
    status: result.status,
    is_error: result.isError,
    duration_ms: Math.round(performance.now() - started),
    credential: prepared.credential,
    response: { sha256: textHash(result.content), length: result.content.length },
    shown: { length: shown.length, selected: prepared.select !== null && !result.isError },
    truncated_to: shown.length > limit ? limit : null,
  });
  const parsed = parseResult(result.content);
  return {
    shown: { ...result, content: truncate(shown, limit) },
    evidence: { tool: operation, arguments: args, result: parsed, is_error: result.isError },
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
  /** Mechanical steps Stepgate passed since the client's last view, in order. */
  completed: string[];
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
  const append = createLedger(runContext.ledger, { run: id, stepfile: written.document.id });
  let prepared: Prepared | undefined;
  let ended = false;
  const recorded: RecordedStep[] = [];
  const end = async (type: string, fields: JsonObject) => {
    ended = true;
    await append(type, fields);
    await prepared?.close();
    if (runContext.recordCases !== null && type !== "run_abandoned") {
      await runContext.recordCases({ stepfile: written.document.id, run: id, inputs, steps: recorded });
    }
  };
  const record = (step: string, calls: EvidenceCall[], output: Json, failures: GateDiagnosis[]) => {
    recorded.push({ step, calls, output, expect: failures.length === 0 ? "pass" : { fail: failures.map((failure) => failure.gate) } });
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
    await append("run_started", { identity: written.identity, inputs: canonicalHash(inputs) });
    // Settings are filled in first, so the host allowlist below only ever holds concrete hosts.
    const stepfile: Stepfile = { ...written, document: await resolveSettings(written.document, runContext) };
    const http: HttpContext = { allowedHosts: new Set(Object.values(stepfile.document.tools ?? {}).map(declaredToolHost)), append, userAgent: runContext.userAgent, credentials: runContext.credentials, limits: runContext.limits };
    prepared = await preflight(stepfile, inputs, runContext, http);
    const ajv = createValidator();
    const gates = new Map<string, StepGates>(stepfile.document.steps.map((step) => [step.id, compileStepGates(stepfile.document, { http, approvals: runContext.approvals }, step, ajv)]));
    return { stepfile, tools: prepared.tools, gates };
  });
  const steps = session.stepfile.document.steps;
  const defs = { $defs: { ...(session.stepfile.document.$defs ?? {}) } };
  const outputs: Record<string, JsonObject> = {};
  let current: Current | null = null;

  let completed: string[] = [];
  const view = (open: Current): StepView => ({
    step: open.step.id,
    number: open.index + 1,
    total: steps.length,
    instructions: open.instructions,
    operations: [...open.allowed.values()].map((tool) => tool.definition),
    produces: inlineLocalRefs(submittedSchema(open.step), defs, []) as JsonObject,
    attempts_left: (open.step.retries ?? 0) + 2 - open.attempt,
    completed,
  });

  /** Makes a mechanical step's calls in order and computes its output, then applies its gates; any failure ends the run. */
  const perform = async (step: Step, work: MechanicalWork): Promise<void> => {
    const responses: JsonObject = {};
    const calls: EvidenceCall[] = [];
    for (const planned of work.calls ?? []) {
      const tool = session.tools.get(planned.operation) as StepOperation;
      const elements = planned.each === undefined ? null : evaluateExpression(planned.each, { inputs, steps: outputs, responses });
      if (planned.each !== undefined && !Array.isArray(elements)) {
        throw new CallArgumentsInvalid(step.id, planned.id, planned.operation, `each must give an array, and gave ${JSON.stringify(elements)}`);
      }
      const results: Json[] = [];
      for (const item of Array.isArray(elements) ? elements : [null]) {
        if (calls.length >= runContext.limits.callsPerStep) {
          throw new CallLimitReached(step.id, runContext.limits.callsPerStep);
        }
        const args = evaluateTemplate(planned.arguments ?? {}, { inputs, steps: outputs, responses, item });
        if (typeof args !== "object" || args === null || Array.isArray(args) || !tool.validateArgs(args)) {
          throw new CallArgumentsInvalid(step.id, planned.id, planned.operation, describeErrors(tool.validateArgs.errors) || "arguments must be an object");
        }
        const { shown, evidence } = await callTool(tool, planned.operation, args, step.id, { by: "stepgate", call: planned.id }, append, Number.MAX_SAFE_INTEGER);
        if (shown.isError || evidence === null) {
          throw new ToolCallFailed(`call ${planned.id} (${planned.operation})`, shown.status, shown.content);
        }
        results.push(evidence.result);
        calls.push(evidence);
      }
      responses[planned.id] = planned.each === undefined ? results[0] ?? null : results;
    }
    const output = evaluateTemplate(work.output, { inputs, steps: outputs, responses });
    await append("computed", { step: step.id, output: { sha256: canonicalHash(output), length: JSON.stringify(output).length } });
    const checked = await (session.gates.get(step.id) as StepGates).check({ inputs, steps: outputs, output, calls });
    for (const { gate, passed, diagnosis } of checked.verdicts) {
      await append("gate", { step: step.id, attempt: 1, gate, verdict: passed ? "pass" : "fail", diagnosis: diagnosis === null ? null : textHash(diagnosis) });
    }
    const failures = checked.verdicts.flatMap(({ gate, passed, diagnosis }) => (passed ? [] : [{ gate, diagnosis: diagnosis ?? "" }]));
    record(step.id, calls, output, failures);
    if (failures.length > 0) {
      throw new GateFailed(step.id, failures);
    }
    await append("step_passed", { step: step.id, attempt: 1 });
    outputs[step.id] = checked.output as JsonObject;
  };

  const advance = async (from: number): Promise<Progress> => {
    completed = [];
    for (let index = from; index < steps.length; index += 1) {
      const step = steps[index] as Step;
      if (step.when !== undefined && !evaluatePredicate(step.when, { inputs, steps: outputs })) {
        await append("step_skipped", { step: step.id });
        continue;
      }
      if (step.do !== undefined) {
        await append("step_started", { step: step.id });
        await perform(step, step.do);
        completed = [...completed, step.id];
        continue;
      }
      const allowed = new Map((step.tools ?? []).flatMap((name) => {
        const tool = session.tools.get(name);
        return tool === undefined ? [] : [[name, tool] as const];
      }));
      const instructions = renderInstructions(step.id, step.instructions ?? "", { inputs, steps: outputs });
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
      const { shown, evidence } = await callTool(tool, operation, args ?? {}, open.step.id, { by: "client" }, append, runContext.limits.toolResultChars);
      if (evidence !== null) {
        open.calls = [...open.calls, evidence];
      }
      return shown;
    }),
    submit: (output) => serial(async () => {
      const open = current as Current;
      const { step, attempt } = open;
      await append("submit", { step: step.id, attempt, output: { sha256: canonicalHash(output ?? null), length: JSON.stringify(output ?? null).length } });
      const checked = await (session.gates.get(step.id) as StepGates).check({ inputs, steps: outputs, output: output ?? null, calls: open.calls });
      if (checked.derived && checked.output !== null) {
        await append("derived", { step: step.id, attempt, output: { sha256: canonicalHash(checked.output), length: JSON.stringify(checked.output).length } });
      }
      const verdicts = checked.verdicts;
      for (const { gate, passed, diagnosis } of verdicts) {
        await append("gate", { step: step.id, attempt, gate, verdict: passed ? "pass" : "fail", diagnosis: diagnosis === null ? null : textHash(diagnosis) });
      }
      const failures = verdicts.flatMap(({ gate, passed, diagnosis }) => (passed ? [] : [{ gate, diagnosis: diagnosis ?? "" }]));
      record(step.id, open.calls, output ?? null, failures);
      if (failures.length === 0) {
        await append("step_passed", { step: step.id, attempt });
        outputs[step.id] = checked.output as JsonObject;
        return advance(open.index + 1);
      }
      if (attempt > (step.retries ?? 0)) {
        throw new GateFailed(step.id, failures);
      }
      open.attempt += 1;
      return { state: "rejected", failures, attempts_left: view(open).attempts_left };
    }),
    // Queued behind any call in flight, so its connections are not closed under it; request deadlines bound the wait.
    abandon: () => serial(async () => {
      await end("run_abandoned", {});
    }).catch((error: unknown) => {
      if (!(error instanceof RunNotActive)) {
        throw error;
      }
    }),
  };
  return { run, progress };
}
