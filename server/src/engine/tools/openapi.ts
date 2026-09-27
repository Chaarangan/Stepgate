import { parse as parseYaml } from "yaml";
import { PreflightFailed, ToolCallFailed } from "../errors.ts";
import { guardedFetch, type CredentialBinding, type HttpContext } from "../http.ts";
import { textHash } from "../identity.ts";
import { inlineLocalRefs, RefNotInlinable } from "../json-schema.ts";
import type { Json, JsonObject, JsonSchema, ToolDeclaration, ToolDefinition } from "../types.ts";
import type { ToolResult } from "./tool-result.ts";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

type Parameter = { name: string; in: "path" | "query" | "header" | "cookie"; required: boolean; schema: JsonSchema };

type Operation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Parameter[];
  body: { schema: JsonSchema; required: boolean } | null;
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

function findOperations(document: JsonObject, toolName: string): Map<string, Operation> {
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
      }));
      const requestBody = isObject(operation.requestBody) ? operation.requestBody : null;
      const content = requestBody !== null && isObject(requestBody.content) ? requestBody.content : {};
      const json = content["application/json"];
      const body = isObject(json) && isObject(json.schema) ? { schema: json.schema, required: requestBody?.required === true } : null;
      const security = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : [];
      operations.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        parameters,
        body,
        summary: typeof operation.summary === "string" ? operation.summary : typeof operation.description === "string" ? operation.description : "",
        security: isObject(security[0]) ? security[0] : null,
      });
    }
  }
  return operations;
}

/** The value of a parameter that allows exactly one value (`const` or a one-item `enum`), which is sent without asking the model. */
function constantValue(schema: JsonSchema): Json | undefined {
  if ("const" in schema) {
    return schema.const;
  }
  return Array.isArray(schema.enum) && schema.enum.length === 1 ? schema.enum[0] : undefined;
}

function toDefinition(operation: Operation): ToolDefinition {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const parameter of operation.parameters) {
    if (constantValue(parameter.schema) !== undefined) {
      continue;
    }
    properties[parameter.name] = parameter.schema;
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
  const response = await guardedFetch({ ...context, allowedHosts: allowed }, `fetch OpenAPI document for ${toolName}`, url, { method: "GET" }, null);
  const text = await response.text();
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
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (parameter.in === "path") {
          path = path.replace(`{${parameter.name}}`, encodeURIComponent(text));
        } else if (parameter.in === "query") {
          query.set(parameter.name, text);
        } else if (parameter.in === "header") {
          headers.set(parameter.name, text);
        }
      }
      const url = new URL(`${base}${path}`);
      query.forEach((value, key) => url.searchParams.set(key, value));
      const init: RequestInit = { method: operation.method, headers };
      if (operation.body !== null && args.body !== undefined) {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(args.body);
      }
      const response = await guardedFetch(context, `${toolName}.${operationId}`, url, init, bindings.get(operationId) ?? null);
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new ToolCallFailed(`${toolName}.${operationId}`, response.status, text);
      }
      return { content: response.ok ? text : `HTTP ${response.status}: ${text}`, isError: !response.ok, status: response.status };
    },
    close: async () => {},
  };
}
