import { PreflightFailed, SettingUnavailable } from "./errors.ts";
import type { RunContext, SettingDeclaration, StepfileDocument } from "./types.ts";

// A single DNS label: enough for a site, subdomain or account name, and nothing that could redirect
// a request to another host (no dots, slashes, colons or "@").
const DEFAULT_PATTERN = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

const PLACEHOLDER = /\{([a-z][a-z0-9-]*)\}/g;

/** The setting names used as {name} placeholders in a string. */
export function settingNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

/** The environment variable a setting is read from: `jira-site` is JIRA_SITE. */
export function settingVariable(name: string): string {
  return name.toUpperCase().replaceAll("-", "_");
}

function fill(text: string, values: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => values.get(name) ?? `{${name}}`);
}

/**
 * The document with every {setting} in tool URLs and credential hosts replaced by the operator's
 * value. Runs before the host allowlist is built, so allowed hosts are always concrete.
 */
export async function resolveSettings(document: StepfileDocument, runContext: RunContext): Promise<StepfileDocument> {
  const declared: Array<[string, SettingDeclaration]> = Object.entries(document.settings ?? {});
  if (declared.length === 0) {
    return document;
  }
  const values = new Map<string, string>();
  for (const [name, declaration] of declared) {
    let value: string;
    try {
      value = await runContext.settings(name, declaration);
    } catch (error) {
      if (error instanceof SettingUnavailable) {
        throw new PreflightFailed(`setting ${name}`, error.message, { cause: error });
      }
      throw error;
    }
    const pattern = declaration.pattern ?? DEFAULT_PATTERN;
    if (!new RegExp(pattern).test(value)) {
      throw new PreflightFailed(`setting ${name}`, `value ${JSON.stringify(value)} does not match ${pattern}`);
    }
    values.set(name, value);
  }
  const tools = Object.fromEntries(Object.entries(document.tools ?? {}).map(([toolName, tool]) => [toolName, {
    ...tool,
    ...(tool.mcp === undefined ? {} : { mcp: { ...tool.mcp, url: fill(tool.mcp.url, values) } }),
    ...(tool.verifier === undefined ? {} : { verifier: { ...tool.verifier, url: fill(tool.verifier.url, values) } }),
    ...(tool.openapi === undefined ? {} : {
      openapi: {
        ...tool.openapi,
        server: fill(tool.openapi.server, values),
        ...(tool.openapi.url === undefined ? {} : { url: fill(tool.openapi.url, values) }),
      },
    }),
  }]));
  const credentials = Object.fromEntries(Object.entries(document.credentials ?? {}).map(([name, credential]) => [name, {
    ...credential,
    hosts: credential.hosts.map((host) => fill(host, values)),
  }]));
  return { ...document, tools, credentials };
}
