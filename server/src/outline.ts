import { parse as parseYaml, stringify } from "yaml";
import type { Json, JsonObject } from "./engine/types.ts";

const NO_RULE = "TODO(gate): the procedure states no rule for this step; check a real property of its output";

type Section = { id: string; text: string };

/** A stepfile identifier from free text: lowercase words joined by hyphens, starting with a letter. */
function slug(text: string, fallback: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return /^[a-z]/.test(words) ? words : fallback;
}

function frontmatter(text: string): { fields: JsonObject; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) {
    return { fields: {}, body: text };
  }
  const fields = parseYaml(match[1] ?? "") as Json;
  return { fields: fields !== null && typeof fields === "object" && !Array.isArray(fields) ? fields : {}, body: text.slice(match[0].length) };
}

/** Second-level headings when there are any, otherwise top-level numbered items, otherwise the whole body. */
function sections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  if (lines.some((line) => line.startsWith("## "))) {
    const found: Array<{ title: string; lines: string[] }> = [];
    for (const line of lines) {
      if (line.startsWith("## ")) {
        found.push({ title: line.slice(3).trim(), lines: [] });
      } else {
        found.at(-1)?.lines.push(line);
      }
    }
    return found.map(({ title, lines: text }, index) => ({ id: slug(title, `step-${index + 1}`), text: text.join("\n").trim() || title }));
  }
  const items: string[][] = [];
  for (const line of lines) {
    const item = /^\d+[.)]\s+(.*)$/.exec(line);
    if (item !== null) {
      items.push([item[1] ?? ""]);
    } else if (items.length > 0 && line.trim() !== "" && !line.startsWith("#")) {
      items.at(-1)?.push(line.trim());
    }
  }
  if (items.length > 0) {
    return items.map((item, index) => ({ id: `step-${index + 1}`, text: item.join(" ").trim() }));
  }
  return [{ id: "step-1", text: lines.filter((line) => !line.startsWith("# ")).join("\n").trim() }];
}

/** The sentences that state a rule: RFC 2119 words in capitals, or "must" and "never" in any case. */
function rules(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => /\b(MUST|SHALL|REQUIRED)\b/.test(sentence) || /\b(must|never)\b/i.test(sentence));
}

/**
 * A skeleton stepfile for a SKILL.md or markdown SOP: one agent step per section, with its text as instructions and
 * each rule it states as a `TODO(gate)`. What only an author can write is marked `TODO(...)`, which stepgate_validate lists.
 */
export function outlineProcedure(text: string): string {
  const { fields, body } = frontmatter(text);
  const title = /^# (.+)$/m.exec(body)?.[1]?.trim();
  const name = typeof fields.name === "string" ? fields.name : title ?? "procedure";
  const skeleton: JsonObject = {
    stepgate: "1",
    id: slug(name, "procedure"),
    ...(typeof fields.description === "string" ? { description: fields.description } : {}),
    inputs: "TODO(inputs): a JSON Schema object for what a run starts with",
    steps: sections(body).map(({ id, text: instructions }) => {
      const stated = rules(instructions);
      return {
        id,
        instructions,
        produces: "TODO(produces): the JSON Schema of the output this step submits",
        gates: stated.length === 0 ? [NO_RULE] : stated.map((rule) => `TODO(gate): ${rule}`),
      };
    }),
  };
  return stringify(skeleton, { lineWidth: 0 });
}

function markersUnder(value: unknown, path: string): Array<{ path: string; text: string }> {
  if (typeof value === "string") {
    return value.startsWith("TODO(") ? [{ path: path || "/", text: value }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => markersUnder(item, `${path}/${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => markersUnder(item, `${path}/${key}`));
  }
  return [];
}

/** Every string in a draft that is still a `TODO(...)` marker, with its JSON Pointer path. */
export function markers(draft: unknown): Array<{ path: string; text: string }> {
  return markersUnder(draft, "");
}
