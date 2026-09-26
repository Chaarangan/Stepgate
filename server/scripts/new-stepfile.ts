// Scaffolds stepfiles/<id>/ with a working stepfile and a README to fill in.
//
//   npm run new-stepfile -- <id>
//
// The files carry TODO(<id>) markers, which the catalog rules reject until they are replaced.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const id = process.argv[2];
if (id === undefined || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
  console.error("usage: npm run new-stepfile -- <id>   (lowercase letters, digits and hyphens, starting with a letter)");
  process.exit(2);
}

const folder = new URL(`../../stepfiles/${id}/`, import.meta.url);
if (existsSync(folder)) {
  console.error(`stepfiles/${id}/ already exists`);
  process.exit(1);
}

const stepfile = `# yaml-language-server: $schema=../../server/schema/stepfile.schema.json
stepgate: "1"
id: ${id}
title: TODO(${id}) a short title
description: TODO(${id}) one sentence on what this does; clients show it as the tool description.

inputs:
  type: object
  required: [topic]
  properties:
    topic: { type: string, minLength: 1 }

# Declare remote APIs under tools: and the secrets they need under credentials:.
# See docs/stepfile.md for the fields, and stepfiles/market-research/ for a full example.

steps:
  - id: summarise
    instructions: |
      Write a three-sentence summary of {{inputs.topic}}.
    produces:
      type: object
      required: [summary]
      properties:
        summary: { type: string }
    gates:
      - id: long-enough
        schema: { properties: { summary: { minLength: 80 } } }
    retries: 1
`;

const readme = `# ${id}

TODO(${id}) what this stepfile does, and when someone would use it.

## Steps

1. **summarise**: TODO(${id}) what the step does, and what its gates check.

## Inputs

| Input | Meaning |
|---|---|
| \`topic\` | TODO(${id}) |

## Credentials

None.

## Run it

\`\`\`sh
npx -y stepgate ${id}
\`\`\`

Then call the \`${id}\` tool with \`{ "topic": "..." }\`.
`;

mkdirSync(folder, { recursive: true });
writeFileSync(new URL(`${id}.stepfile.yaml`, folder), stepfile);
writeFileSync(new URL("README.md", folder), readme);
console.log(`created stepfiles/${id}/: replace every TODO(${id}), then run npm run check`);
