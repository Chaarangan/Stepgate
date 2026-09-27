import { parse as parseYaml } from "yaml";
import { ApiDocumentInvalid, PreflightFailed, ToolCallFailed, type StepgateError } from "../errors.ts";
import { guardedFetch, readText, type CredentialBinding, type HttpContext } from "../http.ts";
import { textHash } from "../identity.ts";
import { inlineLocalRefs, RefNotInlinable } from "../json-schema.ts";
import type { Json, JsonObject, JsonSchema, ToolDeclaration, ToolDefinition } from "../types.ts";
import { matchesSearch, oneLine, type InspectRequest, type PreparedTool, type ToolKind } from "./tool.ts";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
const MAX_LISTED = 150;

type Parameter = { name: string; in: "path" | "query" | "header" | "cookie"; required: boolean; schema: JsonSchema; explode: boolean; description: string | null };

export type Operation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Parameter[];
  body: { schema: JsonSchema; required: boolean; contentType: string } | null;
  /** The JSON schema of the first 2xx response, which is what a step's gates read as a call's result. */
  response: JsonSchema | null;
  summary: string;
  security: JsonObject | null;
};

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Inlines local `$ref`s; one that cannot be inlined raises the error `fail` builds, which differs for a run and for inspection. */
function inlineRefs(value: Json, document: JsonObject, fail: (message: string) => StepgateError): Json {
  try {
    return inlineLocalRefs(value, document, []);
  } catch (error) {
    if (error instanceof RefNotInlinable) {
      throw fail(error.message);
    }
    throw error;
  }
}

/** Every operation in the document that has an operationId, with `$ref`s inlined. */
function findOperations(document: JsonObject, fail: (message: string) => StepgateError): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = inlineRefs(rawItem, document, fail);
    if (!isObject(item)) {
      continue;
    }
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation) || typeof operation.operationId !== "string") {
        continue;
      }
      const own = Array.isArray(operation.parameters) ? operation.parameters : [];
      const parameters = [...shared, ...own].filter(isObject).map((parameter) => ({
        name: String(parameter.name),
        in: parameter.in as Parameter["in"],
        required: parameter.required === true || parameter.in === "path",
        schema: isObject(parameter.schema) ? parameter.schema : {},
        // OpenAPI's default for query parameters is form style with explode: true, so an array repeats the name.
        explode: parameter.explode === undefined ? parameter.in === "query" : parameter.explode === true,
        description: typeof parameter.description === "string" ? parameter.description : null,
      }));
      const requestBody = isObject(operation.requestBody) ? operation.requestBody : null;
      const content = requestBody !== null && isObject(requestBody.content) ? requestBody.content : {};
      const body = requestBodyOf(content, requestBody?.required === true);
      const security = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : [];
      operations.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        parameters,
        body,
        response: successSchema(operation),
        summary: typeof operation.summary === "string" ? operation.summary : typeof operation.description === "string" ? operation.description : "",
        security: isObject(security[0]) ? security[0] : null,
      });
    }
  }
  return operations;
}

function successSchema(operation: JsonObject): JsonSchema | null {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const status = Object.keys(responses).sort().find((code) => /^2(\d\d|XX)$/.test(code));
  const response = status === undefined ? undefined : responses[status];
  const content = isObject(response) && isObject(response.content) ? response.content : {};
  const json = content["application/json"];
  return isObject(json) && isObject(json.schema) ? json.schema : null;
}

function scalarText(value: Json | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/**
 * The request body Stepgate can send: JSON when the operation accepts it, otherwise a plain string for a
 * text/* or message/* content type (for example a raw email as message/rfc822). Other bodies are not sent.
 */
function requestBodyOf(content: JsonObject, required: boolean): Operation["body"] {
  const json = content["application/json"];
  if (isObject(json) && isObject(json.schema)) {
    return { schema: json.schema, required, contentType: "application/json" };
  }
  const textType = Object.keys(content).find((type) => /^(text|message)\//.test(type));
  return textType === undefined ? null : { schema: { type: "string" }, required, contentType: textType };
}

/** The value of a parameter that allows exactly one value (`const` or a one-item `enum`), which is sent without asking the model. */
function constantValue(schema: JsonSchema): Json | undefined {
  if ("const" in schema) {
    return schema.const;
  }
  return Array.isArray(schema.enum) && schema.enum.length === 1 ? schema.enum[0] : undefined;
}

/** The operation as the client sees it; parameters with one allowed value are left out, since Stepgate sends them. */
function toDefinition(operation: Operation): ToolDefinition {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const parameter of operation.parameters) {
    if (constantValue(parameter.schema) !== undefined) {
      continue;
    }
    // OpenAPI puts a parameter's description beside its schema; the client only sees the schema.
    properties[parameter.name] = parameter.description === null || "description" in parameter.schema ? parameter.schema : { ...parameter.schema, description: parameter.description };
    if (parameter.required) {
      required.push(parameter.name);
    }
  }
  if (operation.body !== null) {
    properties.body = operation.body.schema;
    if (operation.body.required) {
      required.push("body");
    }
  }
  return {
    name: operation.operationId,
    description: operation.summary || `${operation.method} ${operation.path}`,
    inputSchema: { type: "object", properties, required },
  };
}

/** Decides where the secret goes, from the operation's security scheme or the credential's kind. */
function placement(document: JsonObject, operation: Operation, credential: CredentialBinding["declaration"], toolName: string): CredentialBinding["place"] {
  const schemeName = operation.security === null ? undefined : Object.keys(operation.security)[0];
  const components = isObject(document.components) ? document.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const scheme = schemeName === undefined ? undefined : schemes[schemeName];
  if (isObject(scheme) && scheme.type === "apiKey" && typeof scheme.name === "string") {
    const name = scheme.name;
    if (scheme.in === "query") {
      return (secret, _headers, url) => url.searchParams.set(name, secret);
    }
    if (scheme.in === "header") {
      return (secret, headers) => headers.set(name, secret);
    }
  }
  if (credential.kind === "basic") {
    return (secret, headers) => headers.set("Authorization", `Basic ${Buffer.from(secret, "utf8").toString("base64")}`);
  }
  if (credential.kind === "api_key" && !isObject(scheme)) {
    throw new PreflightFailed(`tool ${toolName}`, `operation ${operation.operationId} declares no security scheme saying where an api_key goes`);
  }
  return (secret, headers) => headers.set("Authorization", `Bearer ${secret}`);
}

async function fetchDocument(context: HttpContext, toolName: string, declaration: NonNullable<ToolDeclaration["openapi"]>): Promise<JsonObject> {
  if (declaration.document !== undefined) {
    return declaration.document;
  }
  const url = new URL(declaration.url ?? "");
  const allowed = new Set([...context.allowedHosts, url.host]);
  const operation = `fetch OpenAPI document for ${toolName}`;
  const response = await guardedFetch({ ...context, allowedHosts: allowed }, operation, url, { method: "GET" }, null);
  const text = await readText(response, operation);
  if (!response.ok) {
    throw new PreflightFailed(`tool ${toolName}`, `document fetch returned ${response.status}: ${text.slice(0, 500)}`);
  }
  if (textHash(text) !== declaration.sha256) {
    throw new PreflightFailed(`tool ${toolName}`, `document digest ${textHash(text)} does not match ${declaration.sha256}`);
  }
  const parsed = parseYaml(text) as Json;
  if (!isObject(parsed)) {
    throw new PreflightFailed(`tool ${toolName}`, "document is not an object");
  }
  return parsed;
}

/** Fetches and checks the document, then returns one tool per exposed operation. */
async function prepareOpenApiTool(
  context: HttpContext,
  toolName: string,
  declaration: ToolDeclaration,
  credential: Omit<CredentialBinding, "place"> | null,
): Promise<PreparedTool> {
  const openapi = declaration.openapi;
  if (openapi === undefined) {
    throw new TypeError(`tool ${toolName} is not an openapi tool`);
  }
  const document = await fetchDocument(context, toolName, openapi);
  const operations = findOperations(document, (message) => new PreflightFailed(`tool ${toolName}`, message));
  const exposed = (declaration.exposes ?? []).map((entry) => (typeof entry === "string" ? entry : entry.name));
  const chosen = exposed.map((operationId) => {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      throw new PreflightFailed(`tool ${toolName}`, `operationId ${operationId} is not in the document`);
    }
    return operation;
  });
  const bindings = new Map(
    chosen.map((operation) => [
      operation.operationId,
      credential === null ? null : { ...credential, place: placement(document, operation, credential.declaration, toolName) },
    ]),
  );

  return {
    definitions: chosen.map(toDefinition),
    call: async (operationId, args) => {
      const operation = operations.get(operationId);
      if (operation === undefined) {
        throw new TypeError(`operation ${operationId} was not prepared`);
      }
      const base = openapi.server.endsWith("/") ? openapi.server.slice(0, -1) : openapi.server;
      let path = operation.path;
      const headers = new Headers({ accept: "application/json" });
      const query = new URLSearchParams();
      for (const parameter of operation.parameters) {
        const value = constantValue(parameter.schema) ?? args[parameter.name];
        if (value === undefined) {
          continue;
        }
        const items = Array.isArray(value) ? value.map(scalarText) : [scalarText(value)];
        if (parameter.in === "query" && parameter.explode) {
          items.forEach((item) => query.append(parameter.name, item));
        } else if (parameter.in === "query") {
          query.append(parameter.name, items.join(","));
        } else if (parameter.in === "path") {
          path = path.replace(`{${parameter.name}}`, encodeURIComponent(items.join(",")));
        } else if (parameter.in === "header") {
          headers.set(parameter.name, items.join(","));
        }
      }
      const url = new URL(`${base}${path}`);
      query.forEach((value, key) => url.searchParams.append(key, value));
      const init: RequestInit = { method: operation.method, headers };
      if (operation.body !== null && args.body !== undefined) {
        headers.set("content-type", operation.body.contentType);
        init.body = operation.body.contentType === "application/json" ? JSON.stringify(args.body) : String(args.body);
      }
      const response = await guardedFetch(context, `${toolName}.${operationId}`, url, init, bindings.get(operationId) ?? null);
      const text = await readText(response, `${toolName}.${operationId}`);
      if (response.status === 401 || response.status === 403) {
        throw new ToolCallFailed(`${toolName}.${operationId}`, response.status, text);
      }
      return { content: response.ok ? text : `HTTP ${response.status}: ${text}`, isError: !response.ok, status: response.status };
    },
    close: async () => {},
  };
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


/** Describes an OpenAPI document for an author: the digest to pin, its servers and schemes, and its operations. */
async function inspectOpenApi(context: HttpContext, url: URL, request: InspectRequest): Promise<string> {
  const response = await guardedFetch(context, `inspect ${url}`, url, { method: "GET" }, null);
  const text = await readText(response, `inspect ${url}`);
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
  const operations = findOperations(document, (message) => new ApiDocumentInvalid(url.href, message));
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
      return entry === undefined ? [] : [{ method: entry.method, path: entry.path, parameters: inlineRefs(entry.shared, document, (message) => new ApiDocumentInvalid(url.href, message)), operation: inlineRefs(entry.operation, document, (message) => new ApiDocumentInvalid(url.href, message)) }];
    });
    const sections = [
      definitions.length === 0 ? "" : `Each operation as a step will see it, with its success response; parameters with one allowed value are sent by Stepgate and left out:\n${JSON.stringify(definitions, null, 2)}`,
      raw.length === 0 ? "" : `These have no operationId. To expose one, declare the tool with an inline openapi.document holding this path and method with an operationId added, instead of openapi.url and openapi.sha256:\n${JSON.stringify(raw, null, 2)}`,
      unknown.length === 0 ? "" : `Not in the document: ${unknown.join(", ")}`,
    ].filter((section) => section !== "");
    return `${header}\n\n${sections.join("\n\n")}`;
  }
  const listed = [...operations.values()].filter((operation) => matchesSearch(request.search, operation.operationId, operation.path, operation.summary));
  const lines = listed.slice(0, MAX_LISTED).map((operation) => {
    const parameters = operation.parameters.map((parameter) => `${parameter.name}${parameter.required ? "*" : ""} (${parameter.in})`);
    const body = operation.body === null ? "" : `; body ${operation.body.contentType}`;
    return `- ${operation.operationId}: ${operation.method} ${operation.path}. ${oneLine(operation.summary)} [${parameters.join(", ")}${body}]`;
  });
  const more = listed.length > MAX_LISTED ? `\n\n${listed.length - MAX_LISTED} more; narrow the list with search.` : "";
  const nameless = unnamed.filter((entry) => matchesSearch(request.search, entry.path, typeof entry.operation.summary === "string" ? entry.operation.summary : ""));
  const without = nameless.length === 0
    ? ""
    : `\n\n${nameless.length} operations have no operationId, so a stepfile cannot expose them from this document as it is. Pass them to operations as "METHOD /path" to get their definitions to copy inline:\n${nameless.slice(0, MAX_LISTED).map((entry) => `- ${entry.key}${typeof entry.operation.summary === "string" ? `: ${oneLine(entry.operation.summary)}` : ""}`).join("\n")}`;
  return `${header}\n\n${listed.length} operations${request.search === undefined ? "" : ` matching "${request.search}"`} with an operationId (* marks a required parameter):\n${lines.join("\n")}${more}${without}`;
}

export const openApiKind: ToolKind = { prepare: prepareOpenApiTool, inspect: inspectOpenApi };
