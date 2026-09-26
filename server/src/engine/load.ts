import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { StepfileInvalid, type ValidationIssue } from "./errors.ts";
import { canonicalHash } from "./identity.ts";
import { createValidator } from "./json-schema.ts";
import { placeholderPaths } from "./placeholders.ts";
import { varPaths } from "./predicate.ts";
import type { Stepfile, StepfileDocument, ToolDeclaration } from "./types.ts";

// server/schema/ sits two levels above both src/engine/ and dist/engine/, and ships in the package.
const SCHEMA_URL = new URL("../../schema/stepfile.schema.json", import.meta.url);
const validateDocument = createValidator().compile(JSON.parse(readFileSync(SCHEMA_URL, "utf8")));

function exposedName(entry: string | { name: string }): string {
  return typeof entry === "string" ? entry : entry.name;
}

export function toolUrl(tool: ToolDeclaration): string {
  const url = tool.mcp?.url ?? tool.verifier?.url ?? tool.openapi?.server;
  if (url === undefined) {
    throw new TypeError("tool declares no url; the schema should have rejected it");
  }
  return url;
}

/** The host every request to this tool goes to. */
export function declaredToolHost(tool: ToolDeclaration): string {
  return new URL(toolUrl(tool)).host;
}

function parseText(text: string): unknown {
  try {
    return parseYaml(text, { version: "1.2" });
  } catch (error) {
    throw new StepfileInvalid([{ path: "", message: `does not parse as YAML or JSON: ${(error as Error).message}` }]);
  }
}

function checkCrossFieldRules(document: StepfileDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tools = document.tools ?? {};
  const credentials = document.credentials ?? {};

  const exposedOwners = new Map<string, string>();
  for (const [toolName, tool] of Object.entries(tools)) {
    for (const entry of tool.exposes ?? []) {
      const name = exposedName(entry);
      if (name === "submit") {
        issues.push({ path: `/tools/${toolName}/exposes`, message: "submit is reserved for Stepgate" });
      }
      const owner = exposedOwners.get(name);
      if (owner !== undefined) {
        issues.push({ path: `/tools/${toolName}/exposes`, message: `${name} is already exposed by tool ${owner}` });
      }
      exposedOwners.set(name, toolName);
    }

    if (tool.credential !== undefined) {
      const credential = credentials[tool.credential];
      if (credential === undefined) {
        issues.push({ path: `/tools/${toolName}/credential`, message: `credential ${tool.credential} is not declared` });
      } else {
        const host = declaredToolHost(tool);
        if (!credential.hosts.includes(host)) {
          issues.push({ path: `/tools/${toolName}/credential`, message: `host ${host} is not in credential ${tool.credential}'s hosts` });
        }
        if (tool.mcp !== undefined && credential.kind === "api_key") {
          issues.push({ path: `/tools/${toolName}/credential`, message: "an MCP server takes a bearer or oauth2 credential, not api_key" });
        }
      }
    }
  }

  const seenSteps = new Set<string>();
  document.steps.forEach((step, index) => {
    const path = `/steps/${index}`;
    if (seenSteps.has(step.id)) {
      issues.push({ path: `${path}/id`, message: `step id ${step.id} is not unique` });
    }

    for (const name of step.tools ?? []) {
      if (!exposedOwners.has(name)) {
        issues.push({ path: `${path}/tools`, message: `${name} is not exposed by any tool` });
      }
    }

    const gateIds = new Set<string>();
    for (const gate of step.gates) {
      if (gateIds.has(gate.id)) {
        issues.push({ path: `${path}/gates`, message: `gate id ${gate.id} is not unique in the step` });
      }
      gateIds.add(gate.id);
      if ("http" in gate && tools[gate.http.tool]?.verifier === undefined) {
        issues.push({ path: `${path}/gates/${gate.id}`, message: `${gate.http.tool} is not a verifier tool` });
      }
    }

    const references = [
      ...placeholderPaths(step.instructions),
      ...step.gates.flatMap((gate) => ("predicate" in gate ? varPaths(gate.predicate) : [])),
      ...(step.when === undefined ? [] : varPaths(step.when)),
    ];
    for (const reference of references) {
      const [root, stepId] = reference.split(".");
      if (root === "steps" && (stepId === undefined || !seenSteps.has(stepId))) {
        issues.push({ path, message: `${reference} does not name an earlier step` });
      }
    }
    if (step.when !== undefined && varPaths(step.when).some((reference) => reference.split(".")[0] === "output")) {
      issues.push({ path: `${path}/when`, message: "when is evaluated before the step runs, so it cannot read output" });
    }

    seenSteps.add(step.id);
  });

  return issues;
}

/** Parses, validates and identifies a stepfile. Raises StepfileInvalid with every issue found. */
export function load(text: string): Stepfile {
  const parsed = parseText(text);
  if (!validateDocument(parsed)) {
    throw new StepfileInvalid(
      (validateDocument.errors ?? []).map((error) => ({ path: error.instancePath, message: error.message ?? "is invalid" })),
    );
  }
  const document = parsed as StepfileDocument;
  const issues = checkCrossFieldRules(document);
  if (issues.length > 0) {
    throw new StepfileInvalid(issues);
  }
  return { document, identity: canonicalHash(document) };
}
