import { Ajv } from "ajv";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Json, JsonObject, JsonSchema } from "./types.ts";

export function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  return ajv;
}

const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
const DRAFT_2020_12 = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema$/;

export type ToolSchemaValidators = { draft2020: Ajv2020; draft07: Ajv };

export function createToolSchemaValidators(): ToolSchemaValidators {
  const draft07 = new Ajv({ allErrors: true, strict: false });
  addFormats.default(draft07);
  return { draft2020: createValidator(), draft07 };
}

/**
 * Compiles a schema a remote tool published, under the draft it declares. MCP servers commonly
 * declare draft-07; a schema declaring no draft is read as 2020-12. Any other draft throws.
 */
export function compileToolSchema(validators: ToolSchemaValidators, schema: JsonSchema): ValidateFunction {
  const declared = schema.$schema;
  if (declared === undefined || (typeof declared === "string" && DRAFT_2020_12.test(declared))) {
    return validators.draft2020.compile(schema);
  }
  if (typeof declared === "string" && DRAFT_07.test(declared)) {
    return validators.draft07.compile(schema);
  }
  throw new Error(`unsupported $schema ${String(declared)}; expected draft-07 or 2020-12`);
}

export class RefNotInlinable extends Error {
  override name = "RefNotInlinable";
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Replaces every local `#/...` $ref with its target from `root`, so the schema is self-contained. Cycles throw. */
export function inlineLocalRefs(value: Json, root: JsonObject, trail: string[]): Json {
  if (Array.isArray(value)) {
    return value.map((item) => inlineLocalRefs(item, root, trail));
  }
  if (!isObject(value)) {
    return value;
  }
  const ref = value.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/")) {
      throw new RefNotInlinable(`only local $refs can be inlined, found ${ref}`);
    }
    if (trail.includes(ref)) {
      throw new RefNotInlinable(`recursive $ref ${ref} cannot be inlined`);
    }
    let target: Json | undefined = root;
    for (const segment of ref.slice(2).split("/")) {
      target = isObject(target) ? target[segment.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    }
    if (target === undefined) {
      throw new RefNotInlinable(`$ref ${ref} does not resolve`);
    }
    const { $ref: _ref, ...siblings } = value;
    const resolved = inlineLocalRefs(target, root, [...trail, ref]);
    return Object.keys(siblings).length === 0 || !isObject(resolved) ? resolved : { ...resolved, ...siblings };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineLocalRefs(item, root, trail)]));
}

/** Compiles an author's schema so `#/$defs/<name>` resolves against the stepfile's shared definitions. */
export function compileWithDefs(ajv: Ajv2020, schema: JsonSchema, defs: Record<string, JsonSchema>): ValidateFunction {
  const ownDefs = typeof schema.$defs === "object" && schema.$defs !== null && !Array.isArray(schema.$defs) ? schema.$defs : {};
  return ajv.compile({ ...schema, $defs: { ...defs, ...ownDefs } });
}

export function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}
