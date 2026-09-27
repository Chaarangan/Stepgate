import { parse as parseYaml } from "yaml";
import { PreflightFailed, ToolCallFailed } from "../errors.ts";
import { guardedFetch, readText, type CredentialBinding, type HttpContext } from "../http.ts";
import { textHash } from "../identity.ts";
import { inlineLocalRefs, RefNotInlinable } from "../json-schema.ts";
import type { Json, JsonObject, JsonSchema, ToolDeclaration, ToolDefinition } from "../types.ts";
import type { ToolResult } from "./tool-result.ts";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

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

export type OpenApiTool = {
  definitions: ToolDefinition[];
  call: (operationId: string, args: JsonObject) => Promise<ToolResult>;
  close: () => Promise<void>;
};

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inlineRefs(value: Json, document: JsonObject, toolName: string): Json {
  try {
    return inlineLocalRefs(value, document, []);
  } catch (error) {
    if (error instanceof RefNotInlinable) {
      throw new PreflightFailed(`tool ${toolName}`, error.message, { cause: error });
    }
    throw error;
  }
}

/** Every operation in the document that has an operationId, with `$ref`s inlined. */
export function findOperations(document: JsonObject, toolName: string): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = inlineRefs(rawItem, document, toolName);
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
export function toDefinition(operation: Operation): ToolDefinition {
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
export async function prepareOpenApiTool(
  context: HttpContext,
  toolName: string,
  declaration: ToolDeclaration,
  credential: Omit<CredentialBinding, "place"> | null,
): Promise<OpenApiTool> {
  const openapi = declaration.openapi;
  if (openapi === undefined) {
    throw new TypeError(`tool ${toolName} is not an openapi tool`);
  }
  const document = await fetchDocument(context, toolName, openapi);
  const operations = findOperations(document, toolName);
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
