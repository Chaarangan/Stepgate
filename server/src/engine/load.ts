import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { StepfileInvalid, type ValidationIssue } from "./errors.ts";
import { canonicalHash } from "./identity.ts";
import { createValidator } from "./json-schema.ts";
import { placeholderPaths } from "./placeholders.ts";
import { matchAllPatterns, operatorArguments, resultsProblem, varPaths } from "./predicate.ts";
import { patternProblem, schemaPatterns } from "./regex.ts";
import { settingNames } from "./settings.ts";
import type { CredentialDeclaration, Stepfile, StepfileDocument, ToolDeclaration } from "./types.ts";

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

/** The host every request to this tool goes to; before settings are resolved it may hold {name} placeholders. */
export function declaredToolHost(tool: ToolDeclaration): string {
  const authority = /^[a-z]+:\/\/([^/?#]+)/.exec(toolUrl(tool))?.[1];
  if (authority === undefined) {
    throw new TypeError(`tool url ${toolUrl(tool)} has no host; the schema should have rejected it`);
  }
  return authority.toLowerCase();
}

/** The credential a tool binds, with its declaration, or null when the tool takes none. */
export function credentialOf(document: StepfileDocument, toolName: string): { name: string; declaration: CredentialDeclaration } | null {
  const name = document.tools?.[toolName]?.credential;
  const declaration = name === undefined ? undefined : document.credentials?.[name];
  return name === undefined || declaration === undefined ? null : { name, declaration };
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
      if (typeof entry !== "string" && entry.schema_sha256 !== undefined && tool.mcp === undefined) {
        issues.push({ path: `/tools/${toolName}/exposes`, message: `${name}: schema_sha256 pins an MCP tool's schema; an OpenAPI operation is pinned by the document's sha256` });
      }
      if (typeof entry !== "string" && entry.select !== undefined) {
        if (operatorArguments(entry.select, "results").length > 0) {
          issues.push({ path: `/tools/${toolName}/exposes`, message: `${name}: select sees one result, so it cannot use results` });
        }
        for (const pattern of matchAllPatterns(entry.select)) {
          const problem = patternProblem(pattern);
          if (problem !== null) {
            issues.push({ path: `/tools/${toolName}/exposes`, message: `${name}: ${problem}` });
          }
        }
      }
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
        if (tool.mcp !== undefined && (credential.kind === "api_key" || credential.kind === "basic")) {
          issues.push({ path: `/tools/${toolName}/credential`, message: `an MCP server takes a bearer or oauth2 credential, not ${credential.kind}` });
        }
      }
    }
  }

  const declaredSettings = new Set(Object.keys(document.settings ?? {}));
  const usedSettings = new Set<string>();
  const templated: Array<[string, string]> = [
    ...Object.entries(tools).flatMap(([toolName, tool]): Array<[string, string]> => [
      [`/tools/${toolName}`, toolUrl(tool)],
      ...(tool.openapi?.url === undefined ? [] : [[`/tools/${toolName}/openapi/url`, tool.openapi.url] as [string, string]]),
    ]),
    ...Object.entries(credentials).flatMap(([name, credential]) => credential.hosts.map((host): [string, string] => [`/credentials/${name}/hosts`, host])),
  ];
  for (const [path, text] of templated) {
    for (const name of settingNames(text)) {
      usedSettings.add(name);
      if (!declaredSettings.has(name)) {
        issues.push({ path, message: `{${name}} is not a declared setting` });
      }
    }
  }
  for (const name of declaredSettings) {
    if (!usedSettings.has(name)) {
      issues.push({ path: `/settings/${name}`, message: `setting ${name} is declared but no tool URL or credential host uses it` });
    }
  }

  for (const [name, credential] of Object.entries(credentials)) {
    if (credential.token_url !== undefined && settingNames(credential.token_url).length > 0) {
      issues.push({ path: `/credentials/${name}/token_url`, message: "token_url cannot use {setting} placeholders; the refresh token is sent there, so it must be fixed in the file" });
    }
  }

  const patterns: Array<[string, string]> = [
    ...schemaPatterns(document.inputs).map((pattern): [string, string] => ["/inputs", pattern]),
    ...Object.entries(document.$defs ?? {}).flatMap(([name, schema]) => schemaPatterns(schema).map((pattern): [string, string] => [`/$defs/${name}`, pattern])),
    ...Object.entries(document.settings ?? {}).flatMap(([name, setting]) => (setting.pattern === undefined ? [] : [[`/settings/${name}/pattern`, setting.pattern] as [string, string]])),
    ...document.steps.flatMap((step, index) => [
      ...schemaPatterns(step.produces).map((pattern): [string, string] => [`/steps/${index}/produces`, pattern]),
      ...step.gates.flatMap((gate) => ("schema" in gate ? schemaPatterns(gate.schema) : "predicate" in gate ? matchAllPatterns([gate.predicate, gate.explain ?? null]) : []).map((pattern): [string, string] => [`/steps/${index}/gates/${gate.id}`, pattern])),
    ]),
  ];
  for (const [path, pattern] of patterns) {
    const problem = patternProblem(pattern);
    if (problem !== null) {
      issues.push({ path, message: problem });
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
      if ("predicate" in gate) {
        for (const argument of operatorArguments([gate.predicate, gate.explain ?? null], "results")) {
          const problem = resultsProblem(argument);
          if (problem !== null) {
            issues.push({ path: `${path}/gates/${gate.id}`, message: problem });
          }
        }
      }
      if ("http" in gate && tools[gate.http.tool]?.verifier === undefined) {
        issues.push({ path: `${path}/gates/${gate.id}`, message: `${gate.http.tool} is not a verifier tool` });
      }
    }

    const references = [
      ...placeholderPaths(step.instructions),
      ...step.gates.flatMap((gate) => ("predicate" in gate ? [...varPaths(gate.predicate), ...(gate.explain === undefined ? [] : varPaths(gate.explain))] : [])),
      ...(step.when === undefined ? [] : varPaths(step.when)),
    ];
    for (const reference of references) {
      const [root, stepId] = reference.split(".");
      if (root === "steps" && (stepId === undefined || !seenSteps.has(stepId))) {
        issues.push({ path, message: `${reference} does not name an earlier step` });
      }
    }
    if (step.when !== undefined && (varPaths(step.when).some((reference) => ["output", "calls"].includes(reference.split(".")[0] ?? "")) || operatorArguments(step.when, "results").length > 0)) {
      issues.push({ path: `${path}/when`, message: "when is evaluated before the step runs, so it cannot read output or calls" });
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
