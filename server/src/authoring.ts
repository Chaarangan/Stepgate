import { existsSync, readFileSync } from "node:fs";
import { catalogDirectory, catalogFile, listCatalog } from "./catalog.ts";
import { CredentialUnavailable, StepfileInvalid, UrlNotPublic } from "./engine/errors.ts";
import type { HttpContext } from "./engine/http.ts";
import { load, toolUrl } from "./engine/load.ts";
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
5. Call stepgate_try with the draft and example inputs, then drive the run with stepgate_call and stepgate_submit as for any stepfile. Drafts may not declare credentials or settings and may call only public https URLs; a stepfile that needs a key is tried by saving it and adding its path to the server's configuration.
6. Save it as <id>.stepfile.yaml. It runs by passing its absolute path to stepgate.`;

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

/** What the operator lets drafts and inspection reach: public https in production, loopback too in tests. */
export type DraftPolicy = { urlAllowed: (url: string) => boolean };

/** Every rule a draft breaks for stepgate_try; empty when it may run. */
export function draftProblems(stepfile: Stepfile, policy: DraftPolicy): string[] {
  const { document } = stepfile;
  const problems: string[] = [];
  const credentials = Object.keys(document.credentials ?? {});
  if (credentials.length > 0) {
    problems.push(`it declares credentials (${credentials.join(", ")}); drafts run without keys, so save it and add its path to the server's configuration to try it`);
  }
  const settings = Object.keys(document.settings ?? {});
  if (settings.length > 0) {
    problems.push(`it declares settings (${settings.join(", ")}), which come from the operator's environment; save it and add it to the server's configuration to try it`);
  }
  for (const [toolName, tool] of Object.entries(document.tools ?? {})) {
    for (const url of [toolUrl(tool), ...(tool.openapi?.url === undefined ? [] : [tool.openapi.url])]) {
      if (!policy.urlAllowed(url)) {
        problems.push(`tool ${toolName} must use a public https URL, not ${url}`);
      }
    }
  }
  return problems;
}

/** Validates a draft: its issues, or its id, identity and steps and whether stepgate_try accepts it. */
export function validateDraft(text: string, policy: DraftPolicy): { valid: boolean; report: string } {
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
