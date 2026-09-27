import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { catalogDirectory, catalogFile, isPublicHost, listCatalog } from "./catalog.ts";
import { ApiDocumentInvalid, CredentialUnavailable, SettingUnavailable, StepfileInvalid, StepgateError, ToolCallFailed, UrlNotPublic } from "./engine/errors.ts";
import { guardedFetch, type HttpContext } from "./engine/http.ts";
import { canonicalHash, textHash } from "./engine/identity.ts";
import { declaredToolHost, load, toolUrl } from "./engine/load.ts";
import { inlineLocalRefs, RefNotInlinable } from "./engine/json-schema.ts";
import { findOperations, toDefinition } from "./engine/tools/openapi.ts";
import type { Json, JsonObject, Stepfile } from "./engine/types.ts";
import { VERSION } from "./version.ts";

// As with the catalog, the published package carries docs/ beside dist/, and a checkout has it one level higher.
const REFERENCE = [new URL("../docs/stepfile.md", import.meta.url), new URL("../../docs/stepfile.md", import.meta.url)];
const SCHEMA = new URL("../schema/stepfile.schema.json", import.meta.url);
const MAX_LISTED = 150;
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

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
    const summary = (stepfile.document.description ?? stepfile.document.title ?? "").replace(/\s+/g, " ").trim();
    return `- ${id} (${domain}; ${credentials.length === 0 ? "no keys" : `keys: ${credentials.join(", ")}`}): ${summary}`;
  });
  return `${lines.length} catalog stepfiles. Call stepgate_examples with a name to read one.\n\n${lines.join("\n")}`;
}

/** Every rule a draft breaks for stepgate_try; empty when it may run. */
export function draftProblems(stepfile: Stepfile, loopbackAllowed: boolean): string[] {
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
    const url = toolUrl(tool);
    const local = loopbackAllowed && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
    if (!local && (!url.startsWith("https://") || !isPublicHost(declaredToolHost(tool)))) {
      problems.push(`tool ${toolName} must use a public https URL, not ${url}`);
    }
  }
  return problems;
}

/** Validates a draft: its issues, or its id, identity and steps and whether stepgate_try accepts it. */
export function validateDraft(text: string, loopbackAllowed: boolean): { valid: boolean; report: string } {
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
  const problems = draftProblems(stepfile, loopbackAllowed);
  const trying = problems.length === 0 ? "stepgate_try can run it." : `stepgate_try will refuse it:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
  return { valid: true, report: `The stepfile is valid.\nid: ${document.id}\nidentity: ${identity}\nsteps: ${document.steps.map((step) => step.id).join(", ")}\n\n${trying}` };
}

export type InspectRequest = { kind: "openapi" | "mcp"; url: string; search: string | undefined; operations: string[] | undefined };

function inspectionContext(url: URL, userAgent: string): HttpContext {
  const refuse = async (name: string): Promise<string> => {
    throw new CredentialUnavailable(name, "inspection sends no credentials");
  };
  return {
    runContext: {
      credentials: refuse,
      settings: async (name) => {
        throw new SettingUnavailable(name, "inspection reads no settings");
      },
      ledger: () => undefined,
      limits: { callsPerStep: 1, toolResultChars: 1 },
      userAgent,
    },
    allowedHosts: new Set([url.host]),
    append: async () => undefined,
  };
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(search: string | undefined, ...fields: string[]): boolean {
  return search === undefined || fields.some((field) => field.toLowerCase().includes(search.toLowerCase()));
}

type Unnamed = { key: string; method: string; path: string; operation: JsonObject; shared: Json[] };

/** Operations with no operationId, which a stepfile cannot expose until an inline copy of the document gives them one. */
function unnamedOperations(document: JsonObject): Unnamed[] {
  const paths = isObject(document.paths) ? document.paths : {};
  return Object.entries(paths).flatMap(([path, item]) => {
    if (!isObject(item)) {
      return [];
    }
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    return METHODS.flatMap((method) => {
      const operation = item[method];
      return isObject(operation) && typeof operation.operationId !== "string"
        ? [{ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, operation, shared }]
        : [];
    });
  });
}

function inlined(value: Json, document: JsonObject, url: URL): Json {
  try {
    return inlineLocalRefs(value, document, []);
  } catch (error) {
    if (error instanceof RefNotInlinable) {
      throw new ApiDocumentInvalid(url.href, error.message);
    }
    throw error;
  }
}

async function inspectOpenApi(url: URL, context: HttpContext, request: InspectRequest): Promise<string> {
  const response = await guardedFetch(context, `inspect ${url}`, url, { method: "GET" }, null);
  const text = await response.text();
  if (!response.ok) {
    throw new ToolCallFailed(`inspect ${url}`, response.status, text);
  }
  let document: Json;
  try {
    document = parseYaml(text) as Json;
  } catch (error) {
    throw new ApiDocumentInvalid(url.href, `does not parse as JSON or YAML: ${(error as Error).message}`);
  }
  if (!isObject(document)) {
    throw new ApiDocumentInvalid(url.href, "it is not an object");
  }
  const operations = findOperations(document, url.href);
  const servers = (Array.isArray(document.servers) ? document.servers : []).flatMap((server) => (isObject(server) && typeof server.url === "string" ? [server.url] : []));
  const components = isObject(document.components) ? document.components : {};
  const schemes = Object.entries(isObject(components.securitySchemes) ? components.securitySchemes : {}).map(([name, scheme]) =>
    isObject(scheme) ? `${name} (${[scheme.type, scheme.scheme, scheme.in, scheme.name].filter((part) => typeof part === "string").join(" ")})` : name);
  const header = [
    `OpenAPI document ${url.href}`,
    `sha256: ${textHash(text)} (pin this as openapi.sha256, with this URL as openapi.url)`,
    `servers: ${servers.join(", ") || "none listed; set openapi.server to the API's base URL"}`,
    `security schemes: ${schemes.join(", ") || "none"}`,
  ].join("\n");

  const unnamed = unnamedOperations(document);
  if (request.operations !== undefined) {
    const byKey = new Map(unnamed.map((entry) => [entry.key, entry]));
    const unknown = request.operations.filter((id) => !operations.has(id) && !byKey.has(id));
    const definitions = request.operations.flatMap((id) => {
      const operation = operations.get(id);
      return operation === undefined ? [] : [{ method: operation.method, path: operation.path, ...toDefinition(operation), response: operation.response }];
    });
    const raw = request.operations.flatMap((id) => {
      const entry = byKey.get(id);
      return entry === undefined ? [] : [{ method: entry.method, path: entry.path, parameters: inlined(entry.shared, document, url), operation: inlined(entry.operation, document, url) }];
    });
    const sections = [
      definitions.length === 0 ? "" : `Each operation as a step will see it, with its success response; parameters with one allowed value are sent by Stepgate and left out:\n${JSON.stringify(definitions, null, 2)}`,
      raw.length === 0 ? "" : `These have no operationId. To expose one, declare the tool with an inline openapi.document holding this path and method with an operationId added, instead of openapi.url and openapi.sha256:\n${JSON.stringify(raw, null, 2)}`,
      unknown.length === 0 ? "" : `Not in the document: ${unknown.join(", ")}`,
    ].filter((section) => section !== "");
    return `${header}\n\n${sections.join("\n\n")}`;
  }
  const listed = [...operations.values()].filter((operation) => matches(request.search, operation.operationId, operation.path, operation.summary));
  const lines = listed.slice(0, MAX_LISTED).map((operation) => {
    const parameters = operation.parameters.map((parameter) => `${parameter.name}${parameter.required ? "*" : ""} (${parameter.in})`);
    const body = operation.body === null ? "" : `; body ${operation.body.contentType}`;
    return `- ${operation.operationId}: ${operation.method} ${operation.path}. ${operation.summary.replace(/\s+/g, " ").trim()} [${parameters.join(", ")}${body}]`;
  });
  const more = listed.length > MAX_LISTED ? `\n\n${listed.length - MAX_LISTED} more; narrow the list with search.` : "";
  const nameless = unnamed.filter((entry) => matches(request.search, entry.path, typeof entry.operation.summary === "string" ? entry.operation.summary : ""));
  const without = nameless.length === 0
    ? ""
    : `\n\n${nameless.length} operations have no operationId, so a stepfile cannot expose them from this document as it is. Pass them to operations as "METHOD /path" to get their definitions to copy inline:\n${nameless.slice(0, MAX_LISTED).map((entry) => `- ${entry.key}${typeof entry.operation.summary === "string" ? `: ${entry.operation.summary.replace(/\s+/g, " ").trim()}` : ""}`).join("\n")}`;
  return `${header}\n\n${listed.length} operations${request.search === undefined ? "" : ` matching "${request.search}"`} with an operationId (* marks a required parameter):\n${lines.join("\n")}${more}${without}`;
}

async function inspectMcp(url: URL, context: HttpContext, request: InspectRequest): Promise<string> {
  const client = new Client({ name: "stepgate", version: VERSION });
  const transport = new StreamableHTTPClientTransport(url, { fetch: (input, init) => guardedFetch(context, `inspect ${url}`, new URL(input), init ?? {}, null) });
  try {
    // The MCP SDK's own types disagree under exactOptionalPropertyTypes; the runtime object is a Transport.
    await client.connect(transport as Transport);
    const { tools } = await client.listTools();
    const chosen = tools.filter((tool) => (request.operations === undefined ? matches(request.search, tool.name, tool.description ?? "") : request.operations.includes(tool.name)));
    const lines = chosen.map((tool) => {
      const schema = tool.inputSchema as JsonObject;
      const detail = request.operations === undefined ? "" : `\n  arguments: ${JSON.stringify(schema)}`;
      return `- ${tool.name}: ${(tool.description ?? "").replace(/\s+/g, " ").trim()}\n  schema_sha256: ${canonicalHash(schema)}${detail}`;
    });
    return `MCP server ${url.href} offers ${tools.length} tools. Expose one by name, or as { name, schema_sha256 } to pin its input schema.\n\n${lines.join("\n")}`;
  } catch (error) {
    if (error instanceof StepgateError) {
      throw error;
    }
    throw new ToolCallFailed(`inspect ${url}`, null, `could not list tools: ${(error as Error).message}. A server that needs a key cannot be inspected; read its documentation for tool names`, { cause: error });
  } finally {
    await client.close();
  }
}

/** Fetches an API description without credentials and reports what a stepfile needs to declare it. */
export async function inspectApi(request: InspectRequest, userAgent: string, loopbackAllowed: boolean): Promise<string> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new UrlNotPublic(request.url);
  }
  const local = loopbackAllowed && url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!local && (url.protocol !== "https:" || !isPublicHost(url.host))) {
    throw new UrlNotPublic(request.url);
  }
  const context = inspectionContext(url, userAgent);
  return request.kind === "openapi" ? inspectOpenApi(url, context, request) : inspectMcp(url, context, request);
}
