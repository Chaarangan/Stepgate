import type { ValidateFunction } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import {
  CredentialUnavailable,
  GateFailed,
  InvalidGrant,
  ModelTurnFailed,
  PreflightFailed,
  TurnLimitReached,
  type GateDiagnosis,
} from "./errors.ts";
import { evaluateGates } from "./gates.ts";
import type { CredentialBinding, HttpContext } from "./http.ts";
import { canonicalHash, textHash } from "./identity.ts";
import { compileToolSchema, createToolSchemaValidators, createValidator, describeErrors, inlineLocalRefs } from "./json-schema.ts";
import { createLedger, type AppendRecord } from "./ledger.ts";
import { declaredToolHost } from "./load.ts";
import { renderInstructions } from "./placeholders.ts";
import { evaluatePredicate, type EvidenceCall } from "./predicate.ts";
import { resolveSettings } from "./settings.ts";
import { prepareMcpTool } from "./tools/mcp.ts";
import { prepareOpenApiTool } from "./tools/openapi.ts";
import type { ToolResult } from "./tools/tool-result.ts";
import type { Json, RunContext, JsonObject, Message, RunResult, Stepfile, Step, ToolCall, ToolDefinition } from "./types.ts";

const SYSTEM_PROMPT = [
  "You are carrying out one step of a procedure.",
  "Use the tools provided when the instructions call for them.",
  "When the step is complete, call the submit tool once with the result.",
  "If submit returns an error, correct the result and call submit again.",
].join(" ");

type PreparedTool = {
  definition: ToolDefinition;
  validateArgs: ValidateFunction;
  toolName: string;
  host: string;
  credential: string | null;
  call: (args: JsonObject) => Promise<ToolResult>;
};

type Prepared = {
  tools: Map<string, PreparedTool>;
  close: () => Promise<void>;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credentialFor(stepfile: Stepfile, toolName: string): Omit<CredentialBinding, "place"> | null {
  const name = stepfile.document.tools?.[toolName]?.credential;
  const declaration = name === undefined ? undefined : stepfile.document.credentials?.[name];
  return name === undefined || declaration === undefined ? null : { name, declaration };
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

  const tools = new Map<string, PreparedTool>();
  const closers: Array<() => Promise<void>> = [];
  const close = async () => {
    await Promise.all(closers.map((closer) => closer()));
  };
  try {
    for (const [toolName, declaration] of Object.entries(stepfile.document.tools ?? {})) {
      if (declaration.verifier !== undefined) {
        continue;
      }
      const credential = credentialFor(stepfile, toolName);
      const prepared = declaration.mcp !== undefined
        ? await prepareMcpTool(http, toolName, declaration, credential)
        : await prepareOpenApiTool(http, toolName, declaration, credential);
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

/** The submit tool, with the stepfile's `$defs` inlined so the model sees the whole output shape. */
function submitTool(stepfile: Stepfile, step: Step): ToolDefinition {
  const root = { $defs: { ...(stepfile.document.$defs ?? {}) } };
  return {
    name: "submit",
    description: "Submit this step's result. Call it once the step is complete.",
    inputSchema: inlineLocalRefs(step.produces, root, []) as JsonObject,
  };
}

function formatFailures(failures: GateDiagnosis[]): string {
  return `The submission was rejected. Fix every problem below and call submit again.\n${failures
    .map((failure) => `- ${failure.gate}: ${failure.diagnosis}`)
    .join("\n")}`;
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
async function callTool(prepared: PreparedTool, call: ToolCall, stepId: string, append: AppendRecord, limit: number): Promise<{ shown: ToolResult; evidence: EvidenceCall | null }> {
  if (!isObject(call.arguments) || !prepared.validateArgs(call.arguments)) {
    return { shown: { content: `Invalid arguments for ${call.name}: ${describeErrors(prepared.validateArgs.errors) || "arguments must be an object"}`, isError: true, status: null }, evidence: null };
  }
  const started = performance.now();
  const result = await prepared.call(call.arguments);
  await append("tool_call", {
    step: stepId,
    tool: prepared.toolName,
    operation: call.name,
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
    evidence: { tool: call.name, arguments: call.arguments, result: parseResult(result.content), is_error: result.isError },
  };
}

type StepContext = {
  stepfile: Stepfile;
  step: Step;
  inputs: JsonObject;
  outputs: Record<string, JsonObject>;
  tools: Map<string, PreparedTool>;
  runContext: RunContext;
  http: HttpContext;
  append: AppendRecord;
};

/** Runs one step in a fresh context until its gates pass or its retries run out. */
async function runStep(context: StepContext): Promise<JsonObject> {
  const { step, runContext, append } = context;
  const allowed = new Map((step.tools ?? []).flatMap((name) => {
    const prepared = context.tools.get(name);
    return prepared === undefined ? [] : [[name, prepared] as const];
  }));
  const instructions = renderInstructions(step.id, step.instructions, { inputs: context.inputs, steps: context.outputs });
  const tools = [...[...allowed.values()].map((prepared) => prepared.definition), submitTool(context.stepfile, step)];
  const messages: Message[] = [{ role: "user", text: instructions }];
  const retries = step.retries ?? 0;
  let attempt = 1;
  let calls: EvidenceCall[] = [];
  const ajv = createValidator();

  await append("step_started", { step: step.id });
  for (let turn = 0; turn < runContext.limits.turnsPerStep; turn += 1) {
    let reply;
    try {
      reply = await runContext.model({ system: SYSTEM_PROMPT, messages: [...messages], tools });
    } catch (error) {
      throw new ModelTurnFailed(step.id, error);
    }
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls });

    if (reply.toolCalls.length === 0) {
      const failures = [{ gate: "submit", diagnosis: "the turn ended without calling submit" }];
      await append("gate", { step: step.id, attempt, gate: "submit", verdict: "fail", diagnosis: textHash(failures[0]?.diagnosis ?? "") });
      if (attempt > retries) {
        throw new GateFailed(step.id, failures);
      }
      attempt += 1;
      messages.push({ role: "user", text: "Call the submit tool with the step's result." });
      continue;
    }

    let submitted = false;
    for (const call of reply.toolCalls) {
      if (call.name !== "submit") {
        const prepared = allowed.get(call.name);
        if (prepared === undefined) {
          await append("tool_refused", { step: step.id, operation: call.name });
        }
        const { shown, evidence } = prepared === undefined
          ? { shown: { content: `${call.name} is not available in this step.`, isError: true, status: null }, evidence: null }
          : await callTool(prepared, call, step.id, append, runContext.limits.toolResultChars);
        if (evidence !== null) {
          calls = [...calls, evidence];
        }
        messages.push({ role: "tool", toolCallId: call.id, content: shown.content, isError: shown.isError });
        continue;
      }
      if (submitted) {
        messages.push({ role: "tool", toolCallId: call.id, content: "Already submitted in this turn.", isError: true });
        continue;
      }
      submitted = true;
      const output = call.arguments;
      await append("submit", { step: step.id, attempt, output: { sha256: canonicalHash(output ?? null), length: JSON.stringify(output ?? null).length } });
      const failures = await evaluateGates({
        document: context.stepfile.document,
        step,
        context: { inputs: context.inputs, steps: context.outputs, output: (output ?? null) as JsonObject, calls },
        ajv,
        http: context.http,
        verifierCredential: (toolName) => credentialFor(context.stepfile, toolName),
      });
      const failedIds = new Set(failures.map((failure) => failure.gate));
      const checked = failedIds.has("produces") ? ["produces"] : step.gates.map((gate) => gate.id);
      for (const gate of checked) {
        const failure = failures.find((item) => item.gate === gate);
        await append("gate", { step: step.id, attempt, gate, verdict: failure === undefined ? "pass" : "fail", diagnosis: failure === undefined ? null : textHash(failure.diagnosis) });
      }
      if (failures.length === 0) {
        await append("step_passed", { step: step.id, attempt });
        return output as JsonObject;
      }
      if (attempt > retries) {
        throw new GateFailed(step.id, failures);
      }
      attempt += 1;
      messages.push({ role: "tool", toolCallId: call.id, content: formatFailures(failures), isError: true });
    }
  }
  throw new TurnLimitReached(step.id, runContext.limits.turnsPerStep);
}

/** Preflights, then runs every step in order, asking the context's model for one turn at a time. */
export async function run(written: Stepfile, inputs: JsonObject, runContext: RunContext): Promise<RunResult> {
  const append = createLedger(runContext.ledger);
  await append("run_started", { run: randomUUID(), stepfile: written.document.id, identity: written.identity, inputs: canonicalHash(inputs) });
  let prepared: Prepared | undefined;
  try {
    // Settings are filled in first, so the host allowlist below only ever holds concrete hosts.
    const stepfile: Stepfile = { ...written, document: await resolveSettings(written.document, runContext) };
    const http: HttpContext = { runContext, allowedHosts: new Set(Object.values(stepfile.document.tools ?? {}).map(declaredToolHost)), append };
    prepared = await preflight(stepfile, inputs, runContext, http);
    const outputs: Record<string, JsonObject> = {};
    for (const step of stepfile.document.steps) {
      if (step.when !== undefined && !evaluatePredicate(step.when, { inputs, steps: outputs })) {
        await append("step_skipped", { step: step.id });
        continue;
      }
      outputs[step.id] = await runStep({ stepfile, step, inputs, outputs, tools: prepared.tools, runContext, http, append });
    }
    await append("run_finished", { outcome: "passed" });
    return { identity: written.identity, outputs };
  } catch (error) {
    await append("run_failed", { error: error instanceof Error ? error.name : "unknown" });
    throw error;
  } finally {
    await prepared?.close();
  }
}
