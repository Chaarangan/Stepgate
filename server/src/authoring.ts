import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { catalogDirectory, catalogFile, listCatalog } from "./catalog.ts";
import { CredentialUnavailable, StepfileInvalid, UrlNotPublic } from "./engine/errors.ts";
import type { HttpContext } from "./engine/http.ts";
import { load, toolUrl } from "./engine/load.ts";
import { markers } from "./outline.ts";
import { withSampleSettings } from "./engine/settings.ts";
import { toolKinds } from "./engine/tools/kinds.ts";
import { oneLine, type InspectRequest } from "./engine/tools/tool.ts";
import type { Stepfile } from "./engine/types.ts";

// As with the catalog, the published package carries docs/ beside dist/, and a checkout has it one level higher.
const REFERENCE = [new URL("../docs/stepfile.md", import.meta.url), new URL("../../docs/stepfile.md", import.meta.url)];
const SCHEMA = new URL("../schema/stepfile.schema.json", import.meta.url);

const WORKFLOW = `# Writing a stepfile with Stepgate

1. Read the reference below. Then call stepgate_examples to find a catalog stepfile close to the use case, and read it whole.
2. For each OpenAPI API, call stepgate_inspect_api with kind "openapi" and the document's URL. It returns the sha256 to pin, the servers, the security schemes and the operationIds to expose; pass operations to see the arguments each takes. For a remote MCP server, kind "mcp" lists its tools with the schema_sha256 of each.
3. Give every step gates that check its output against \`calls\`, what the APIs actually returned, not only its shape.
4. Call stepgate_validate with the draft and fix every issue it lists.
5. Call stepgate_try with the draft and example inputs, then drive the run with stepgate_call and stepgate_submit as for any stepfile. Drafts may call only public https URLs, and may declare only the credentials and settings the operator granted to drafts (a credential only for the hosts it was granted for); any other stepfile that needs a key is tried by saving it and adding its path to the server's configuration.
6. Save it as <id>.stepfile.yaml. It runs by passing its absolute path to stepgate.

## Starting from a procedure you already have

When the user has the procedure written down, as a SKILL.md, a runbook or an SOP, call stepgate_outline with its text instead of starting from nothing. It returns a skeleton: one agent step per numbered item or second-level heading, and each sentence stating a rule (MUST, SHALL, REQUIRED, must, never) as a TODO(gate) under its step. Then:

- Turn each TODO(gate) into a gate that checks the rule against the output and calls, and add gates for anything else the step's output must satisfy.
- Make a step mechanical, with do, where it needs no judgement: fetching what the inputs name, counting, picking the latest item, copying fields. Use derive for computed fields of an agent step.
- Declare inputs, tools and each step's produces, and replace every remaining TODO marker. stepgate_validate lists the markers left before it checks anything else.`;

function firstExisting(locations: URL[]): URL {
  const found = locations.find((location) => existsSync(location));
  if (found === undefined) {
    throw new Error(`stepfile reference not found; looked in ${locations.map((location) => location.pathname).join(" and ")}`);
  }
  return found;
}

/** The authoring workflow, the format reference and the JSON Schema, as one text. */
export function guide(): string {
  const reference = readFileSync(firstExisting(REFERENCE), "utf8");
  const schema = readFileSync(SCHEMA, "utf8");
  return `${WORKFLOW}\n\n${reference}\n\n## The JSON Schema\n\n\`\`\`json\n${schema.trim()}\n\`\`\``;
}

/** The catalog as a list, or one entry's stepfile and README when `name` is given. */
export function examples(name: string | undefined): string {
  const directory = catalogDirectory();
  if (name !== undefined) {
    const file = catalogFile(directory, name);
    const readme = readFileSync(new URL("README.md", file), "utf8");
    return `# ${name}.stepfile.yaml\n\n\`\`\`yaml\n${readFileSync(file, "utf8").trim()}\n\`\`\`\n\n# README.md\n\n${readme}`;
  }
  const lines = listCatalog(directory).map(({ domain, id, stepfile }) => {
    const credentials = Object.keys(stepfile.document.credentials ?? {});
    const summary = oneLine(stepfile.document.description ?? stepfile.document.title ?? "");
    return `- ${id} (${domain}; ${credentials.length === 0 ? "no keys" : `keys: ${credentials.join(", ")}`}): ${summary}`;
  });
  return `${lines.length} catalog stepfiles. Call stepgate_examples with a name to read one.\n\n${lines.join("\n")}`;
}

/**
 * What the operator lets drafts and inspection reach: URLs (public https in production, loopback too in tests), and
 * the credentials and settings a draft may use. A credential is granted with the hosts it may be sent to.
 */
export type DraftPolicy = {
  urlAllowed: (url: string) => boolean;
  credentials: ReadonlyMap<string, readonly string[]>;
  settings: ReadonlySet<string>;
};

/** Every rule a draft breaks for stepgate_try; empty when it may run. */
export function draftProblems(stepfile: Stepfile, policy: DraftPolicy): string[] {
  const { document } = stepfile;
  const problems: string[] = [];
  for (const [name, credential] of Object.entries(document.credentials ?? {})) {
    const granted = policy.credentials.get(name);
    if (granted === undefined) {
      problems.push(`it declares credential ${name}, which the operator has not granted to drafts; they can start the server with --draft-credential ${name}=<host>, or save the stepfile and add its path to the server's configuration`);
      continue;
    }
    const extra = credential.hosts.filter((host) => !granted.includes(host));
    if (extra.length > 0) {
      problems.push(`credential ${name} lists ${extra.join(", ")}, but the operator granted it only for ${granted.join(", ")}`);
    }
    if (credential.token_url !== undefined) {
      problems.push(`credential ${name} declares a token_url, which would receive the operator's refresh token; drafts may not refresh credentials`);
    }
  }
  const ungranted = Object.keys(document.settings ?? {}).filter((name) => !policy.settings.has(name));
  if (ungranted.length > 0) {
    problems.push(`it declares settings (${ungranted.join(", ")}) the operator has not granted to drafts with --draft-setting; save it and add it to the server's configuration to try it`);
  }
  for (const [toolName, tool] of Object.entries(document.tools ?? {})) {
    for (const url of [toolUrl(tool), ...(tool.openapi?.url === undefined ? [] : [tool.openapi.url])]) {
      if (!policy.urlAllowed(withSampleSettings(url))) {
        problems.push(`tool ${toolName} must use a public https URL, not ${url}`);
      }
    }
  }
  return problems;
}

/** Validates a draft: its issues, or its id, identity and steps and whether stepgate_try accepts it. */
export function validateDraft(text: string, policy: DraftPolicy): { valid: boolean; report: string } {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(text, { version: "1.2" });
  } catch {
    // load below reports the parse error with its position.
  }
  const left = markers(parsed);
  if (left.length > 0) {
    return { valid: false, report: `The stepfile still has parts to write. Replace every marker, then validate again:\n${left.map((marker) => `- ${marker.path}: ${marker.text}`).join("\n")}` };
  }
  let stepfile: Stepfile;
  try {
    stepfile = load(text);
  } catch (error) {
    if (error instanceof StepfileInvalid) {
      return { valid: false, report: `The stepfile is invalid. Fix every issue:\n${error.issues.map((issue) => `- ${issue.path || "/"}: ${issue.message}`).join("\n")}` };
    }
    throw error;
  }
  const { document, identity } = stepfile;
  const problems = draftProblems(stepfile, policy);
  const trying = problems.length === 0 ? "stepgate_try can run it." : `stepgate_try will refuse it:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
  return { valid: true, report: `The stepfile is valid.\nid: ${document.id}\nidentity: ${identity}\nsteps: ${document.steps.map((step) => step.id).join(", ")}\n\n${trying}` };
}


/** Who inspection says it is and how long and how much it may read, taken from the operator's settings. */
export type Outbound = Pick<HttpContext, "userAgent" | "limits">;

function inspectionContext(url: URL, outbound: Outbound): HttpContext {
  return {
    ...outbound,
    allowedHosts: new Set([url.host]),
    append: async () => undefined,
    credentials: {
      value: async (name) => {
        throw new CredentialUnavailable(name, "inspection sends no credentials");
      },
      rejected: async () => false,
    },
  };
}

/** Fetches an API description without credentials and reports what a stepfile needs to declare it. */
export async function inspectApi(request: InspectRequest, outbound: Outbound, policy: DraftPolicy): Promise<string> {
  if (!policy.urlAllowed(request.url)) {
    throw new UrlNotPublic(request.url);
  }
  const url = new URL(request.url);
  return toolKinds[request.kind].inspect(inspectionContext(url, outbound), url, request);
}
