import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { draftProblems, examples, guide, inspectApi, validateDraft, type DraftPolicy } from "./authoring.ts";
import { DraftRefused, RunNotActive, StepgateError, ToolCallFailed } from "./engine/errors.ts";
import { load } from "./engine/load.ts";
import type { Progress, StepView } from "./engine/run.ts";
import { createRuns } from "./engine/runs.ts";
import type { LedgerSink } from "./engine/ledger.ts";
import type { Served } from "./served.ts";
import { VERSION } from "./version.ts";
import type { Approvals, Json, JsonObject, RunContext, Stepfile } from "./engine/types.ts";

export type StepgateServerOptions = {
  credentials: RunContext["credentials"];
  settings: RunContext["settings"];
  /** Receives every ledger record; each carries the run and stepfile it belongs to. */
  ledger: LedgerSink;
  /** Where finished and failed runs are written as cases, or null when the operator does not record them. */
  recordCases: RunContext["recordCases"];
  limits: RunContext["limits"];
  /** How long a run may wait for the client's next call before it is abandoned, in milliseconds. */
  runIdleMs: number;
  userAgent: string;
  drafts: DraftPolicy;
};

const CALL = "stepgate_call";
const SUBMIT = "stepgate_submit";
const TRY = "stepgate_try";

const INSTRUCTIONS = `Each stepfile tool starts a run of a fixed procedure and returns its first step. Do each step as instructed: \
call the step's operations only through ${CALL}, then send the step's output to ${SUBMIT}. Stepgate checks the output with the \
step's gates; if it is rejected, fix every listed problem and submit again. Values must come from the operations' results, \
because gates compare them. Continue until the run finishes. To write a new stepfile, call stepgate_guide first: it explains \
the format and the other authoring tools.`;

const CALL_TOOL: Tool = {
  name: CALL,
  title: "Call a step operation",
  description: `Calls one of the current step's operations for a Stepgate run and returns its result. Stepgate makes the request and adds any credentials.`,
  inputSchema: {
    type: "object",
    properties: {
      run: { type: "string", description: "The run id a stepfile tool returned." },
      operation: { type: "string", description: "An operation the current step lists." },
      arguments: { type: "object", description: "Arguments matching the operation's schema." },
    },
    required: ["run", "operation"],
  },
};

const SUBMIT_TOOL: Tool = {
  name: SUBMIT,
  title: "Submit a step's output",
  description: "Submits the current step's output for a Stepgate run. Returns the next step, the gate failures to fix, or the finished run's outputs.",
  inputSchema: {
    type: "object",
    properties: {
      run: { type: "string", description: "The run id a stepfile tool returned." },
      output: { type: "object", description: "The step's output, matching the schema the step gave." },
    },
    required: ["run", "output"],
  },
};

const STEPFILE_TEXT = { type: "string", description: "The whole stepfile, as YAML or JSON text." } as const;

const AUTHORING_TOOLS: Tool[] = [
  {
    name: "stepgate_guide",
    title: "How to write a stepfile",
    description: "Returns how to write a stepfile: the authoring workflow, the full format reference and the JSON Schema. Call it before writing or editing a stepfile.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stepgate_examples",
    title: "Catalog stepfiles to learn from",
    description: "Lists the catalog's stepfiles, or with a name returns that stepfile's YAML and README, to copy a working pattern from.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "A catalog stepfile's id; omit it for the list." } } },
  },
  {
    name: "stepgate_validate",
    title: "Validate a draft stepfile",
    description: "Checks a draft stepfile against the schema and every load-time rule. Returns each issue with its path, or the stepfile's identity and whether stepgate_try accepts it.",
    inputSchema: { type: "object", properties: { stepfile: STEPFILE_TEXT }, required: ["stepfile"] },
  },
  {
    name: "stepgate_inspect_api",
    title: "Inspect an API for a stepfile",
    description: "Fetches a public OpenAPI document or MCP server without credentials and reports what a stepfile needs: the document's sha256, servers, security schemes and operationIds, or an MCP server's tools and their schema_sha256.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["openapi", "mcp"] },
        url: { type: "string", description: "The OpenAPI document's URL, or the MCP server's endpoint." },
        search: { type: "string", description: "Only list operations or tools whose name, path or description contains this." },
        operations: { type: "array", items: { type: "string" }, description: "Return the full argument schema of these operationIds or tool names." },
      },
      required: ["kind", "url"],
    },
  },
  {
    name: TRY,
    title: "Try a draft stepfile",
    description: `Starts a run of a draft stepfile from its text, without adding it to the server. Drive it with ${CALL} and ${SUBMIT}. Drafts may call only public https URLs, and use only the credentials and settings the operator granted to drafts.`,
    inputSchema: {
      type: "object",
      properties: { stepfile: STEPFILE_TEXT, inputs: { type: "object", description: "Inputs matching the draft's inputs schema." } },
      required: ["stepfile", "inputs"],
    },
  },
];

/** A reply with no structuredContent, so clients that prefer it still show the text. */
function plain(message: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text: message }], isError };
}

function text(message: string, structured: JsonObject, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: structured, isError };
}

function describeStep(run: string, view: StepView): string {
  const operations = view.operations.length === 0
    ? "This step has no operations; work from the instructions and what earlier steps returned."
    : `Operations for this step, called with ${CALL}:\n${view.operations
      .map((operation) => `- ${operation.name}: ${operation.description}\n  arguments: ${JSON.stringify(operation.inputSchema)}`)
      .join("\n")}`;
  return [
    ...(view.completed.length === 0 ? [] : [`Stepgate did these steps itself: ${view.completed.join(", ")}.`]),
    `Run ${run}, step ${view.number} of ${view.total}: ${view.step}.`,
    `Instructions:\n${view.instructions.trim()}`,
    operations,
    `When the step is done, call ${SUBMIT} with run "${run}" and an output matching this JSON Schema:\n${JSON.stringify(view.produces)}`,
    `Attempts: ${view.attempts_left}.`,
  ].join("\n\n");
}

function progressResult(run: string, progress: Progress): CallToolResult {
  if (progress.state === "step") {
    return text(describeStep(run, progress.step), { run, state: "running", step: progress.step as unknown as JsonObject }, false);
  }
  if (progress.state === "rejected") {
    const failures = progress.failures.map((failure) => `- ${failure.gate}: ${failure.diagnosis}`).join("\n");
    return text(
      `The output was rejected. Fix every problem below and call ${SUBMIT} again (${progress.attempts_left} attempts left).\n${failures}`,
      { run, state: "running", failures: progress.failures, attempts_left: progress.attempts_left },
      true,
    );
  }
  const { identity, outputs } = progress.result;
  return text(`The run finished. Every step passed its gates. Outputs:\n${JSON.stringify(outputs, null, 2)}`, { run, state: "finished", identity, outputs }, false);
}

function failure(run: string | null, error: StepgateError): CallToolResult {
  const ended = run === null || error instanceof RunNotActive ? "" : "\nThe run has ended.";
  return text(`${error.name}: ${error.message}${ended}`, { run, state: "failed", error: error.name, message: error.message }, true);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * An MCP server exposing each stepfile as a tool that starts a run, plus tools for writing new stepfiles. The client's
 * own agent does each step through `stepgate_call` and `stepgate_submit`, while Stepgate makes every request and applies every gate.
 */
export function createStepgateServer(served: Served, options: StepgateServerOptions): Server {
  const server = new Server({ name: "stepgate", version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
  const runs = createRuns(options.runIdleMs);
  const unsubscribe = served.onChange(() => void server.sendToolListChanged());

  // An approve gate is answered by a person through the client's form elicitation, given as long as a run may idle.
  const askPerson: Approvals["ask"] = async (request) => {
    const shown = JSON.stringify(request.output, null, 2);
    const output = shown.length > options.limits.toolResultChars ? `${shown.slice(0, options.limits.toolResultChars)}\n[cut at ${options.limits.toolResultChars} characters]` : shown;
    let answer: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      answer = await server.elicitInput({
        mode: "form",
        message: `${request.message}\n\nStep ${request.step} of ${request.stepfile} submitted:\n${output}`,
        requestedSchema: { type: "object", properties: { reason: { type: "string", title: "Reason", description: "If you decline, what should change." } } },
      }, { timeout: options.runIdleMs });
    } catch (error) {
      throw new ToolCallFailed(`approval ${request.gate}`, null, `the client did not return a decision: ${(error as Error).message}`, { cause: error });
    }
    const reason = typeof answer.content?.reason === "string" && answer.content.reason.trim() !== "" ? answer.content.reason.trim() : null;
    return answer.action === "accept" ? { approved: true, reason } : { approved: false, reason: reason ?? (answer.action === "cancel" ? "the request was dismissed" : null) };
  };
  server.onclose = () => {
    unsubscribe();
    void runs.abandonAll();
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...served.entries().map((entry): Tool => (entry.stepfile === null
        ? { name: entry.id, description: `This stepfile failed to load after its last edit, so calling it reports why: ${entry.problem.message}`, inputSchema: { type: "object" } }
        : {
          name: entry.id,
          ...(entry.stepfile.document.title === undefined ? {} : { title: entry.stepfile.document.title }),
          description: `${entry.stepfile.document.description ?? entry.stepfile.document.title ?? `Runs the ${entry.id} stepfile.`} Starts a run and returns its first step; do each step with ${CALL} and ${SUBMIT}.`,
          inputSchema: entry.stepfile.document.inputs as Tool["inputSchema"],
        })),
      CALL_TOOL,
      SUBMIT_TOOL,
      ...AUTHORING_TOOLS,
    ],
  }));

  const started = async (stepfile: Stepfile, inputs: JsonObject): Promise<CallToolResult> => {
    const approvals: Approvals = { available: server.getClientCapabilities()?.elicitation?.form !== undefined, ask: askPerson };
    const { run, progress } = await runs.start(stepfile, inputs, { ...options, approvals });
    return progressResult(run, progress);
  };

  const authoring: Record<string, (args: JsonObject) => Promise<{ report: string; isError: boolean }>> = {
    stepgate_guide: async () => ({ report: guide(), isError: false }),
    stepgate_examples: async (args) => ({ report: examples(typeof args.name === "string" ? args.name : undefined), isError: false }),
    stepgate_validate: async (args) => {
      const { valid, report } = validateDraft(typeof args.stepfile === "string" ? args.stepfile : "", options.drafts);
      return { report, isError: !valid };
    },
    stepgate_inspect_api: async (args) => ({
      report: await inspectApi({
        kind: args.kind === "mcp" ? "mcp" : "openapi",
        url: typeof args.url === "string" ? args.url : "",
        search: typeof args.search === "string" ? args.search : undefined,
        operations: Array.isArray(args.operations) ? args.operations.map(String) : undefined,
      }, options, options.drafts),
      isError: false,
    }),
  };

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as JsonObject;
    const id = typeof args.run === "string" ? args.run : null;
    const tool = authoring[request.params.name];
    if (tool !== undefined) {
      try {
        const { report, isError } = await tool(args);
        return plain(report, isError);
      } catch (error) {
        if (error instanceof StepgateError) {
          return plain(`${error.name}: ${error.message}`, true);
        }
        throw error;
      }
    }
    try {
      if (request.params.name === CALL) {
        const run = String(args.run);
        const result = await runs.call(run, String(args.operation), args.arguments as Json | undefined);
        // Some clients (Claude Code among them) show structuredContent in place of the text, so both carry the result.
        return text(result.content, { run, state: "running", result: result.content }, result.isError);
      }
      if (request.params.name === SUBMIT) {
        const run = String(args.run);
        return progressResult(run, await runs.submit(run, isObject(args.output) ? args.output : null));
      }
      if (request.params.name === TRY) {
        const draft = load(typeof args.stepfile === "string" ? args.stepfile : "");
        const problems = draftProblems(draft, options.drafts);
        if (problems.length > 0) {
          throw new DraftRefused(problems);
        }
        return await started(draft, isObject(args.inputs) ? args.inputs : {});
      }
      const entry = served.entries().find((candidate) => candidate.id === request.params.name);
      if (entry === undefined) {
        return text(`no tool named ${request.params.name}`, { run: null, state: "failed", error: "UnknownTool" }, true);
      }
      if (entry.stepfile === null) {
        throw entry.problem;
      }
      return await started(entry.stepfile, args);
    } catch (error) {
      if (error instanceof StepgateError) {
        return failure(id, error);
      }
      throw error;
    }
  });

  return server;
}
