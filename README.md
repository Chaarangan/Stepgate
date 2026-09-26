# Stepgate

[![CI](https://github.com/Chaarangan/stepgate/actions/workflows/ci.yml/badge.svg)](https://github.com/Chaarangan/stepgate/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Agents can't skip steps.** Write an agent's procedure once, as a YAML stepfile, and run it on any MCP client with the model that client already uses.

A **stepfile** declares its inputs, the remote APIs and MCP servers it may call, and an ordered list of steps. Each step says what output it must produce and which **gates** check that output. The file names no model and no framework.

**Stepgate** runs stepfiles. It is an MCP server that offers each stepfile as a tool. When a client calls it, the server borrows the client's model through [MCP sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) and runs the steps itself.

## Why

When an agent is handed a plan as text, it decides how much of the plan to follow, a step counts as done when the agent says so, and nothing records afterwards what actually ran. A stepfile moves those decisions out of the model:

- **Steps run in order, one at a time.** The model sees only the current step's instructions and tools, never the whole plan, so it cannot skip ahead.
- **Gates decide, not the model.** A step passes only when its output satisfies JSON Schema, JSONLogic or an HTTP verifier. A failed gate's diagnosis goes back to the model for a bounded number of retries.
- **The model never holds a key.** The server makes every tool call and attaches credentials itself, and it refuses requests to hosts the stepfile does not declare.
- **Every run leaves a record.** A hash-chained ledger lists each step, tool call, gate verdict and retry, and editing it afterwards breaks the chain.
- **Nothing to install on the client side.** Stepfiles call remote APIs only, and the client adds one MCP server to its configuration.

## Quick start

Add the server to your MCP client's configuration, naming one or more stepfiles from the [catalog](stepfiles/), or giving paths to your own `.stepfile.yaml` files:

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "market-research"],
      "env": { "TAVILY_API_KEY": "tvly-..." }
    }
  }
}
```

The client sees a `market-research` tool. Calling it with `{ "brand": "Oatly", "market": "UK plant-based milk" }` runs four steps (search, filter, analyse, report) and returns each step's output.

To serve over HTTP instead of stdio, run `npx -y stepgate --http 3100 market-research` and connect to `http://127.0.0.1:3100/mcp`. `npx -y stepgate --list` shows the catalog, and `--help` lists the limits and the `--ledger-dir` option.

**Client requirement:** the client must support sampling with tools, declared as the `sampling.tools` capability. A call from a client without it gets a clear tool error. The MCP spec suggests clients let a person approve each sampling request, and a stepfile makes many, so clients that call their model from code are a better fit than desktop apps that prompt every time.

## A stepfile

```yaml
stepgate: "1"
id: market-research
inputs:
  type: object
  required: [brand, market]
  properties:
    brand: { type: string }
    market: { type: string }

credentials:
  tavily:
    kind: bearer
    hosts: [mcp.tavily.com]
    description: Web search, used only by the search step.

tools:
  tavily:
    mcp: { url: "https://mcp.tavily.com/mcp/" }
    credential: tavily
    exposes: [tavily_search]

steps:
  - id: search
    tools: [tavily_search]
    instructions: |
      Run at least six searches about {{inputs.brand}} in {{inputs.market}}.
      Submit every result as a source with an id of the form S-01.
    produces:
      type: object
      required: [sources]
      properties:
        sources: { type: array }
    gates:
      - id: enough-sources
        schema: { properties: { sources: { minItems: 12 } } }
      - id: domain-breadth
        message: Sources must span at least six distinct domains.
        predicate:
          ">=":
            - { length: { unique: { map: [{ var: output.sources }, { host: { var: url } }] } } }
            - 6
    retries: 2
  # ... filter, analyse and report steps
```

Credentials say what is needed, never where it lives: the server reads `tavily` from `TAVILY_API_KEY`. The complete file is [stepfiles/market-research](stepfiles/market-research/), and editors that support `yaml-language-server` validate against [server/schema/stepfile.schema.json](server/schema/stepfile.schema.json), which the npm package also ships.

## Catalog

[stepfiles/](stepfiles/) is a community catalog of stepfiles, reviewed and shipped with the npm package, so each one runs by name. Built something repeatable? Adding it is one folder and one pull request: see [stepfiles/README.md](stepfiles/README.md), or [suggest an idea](https://github.com/Chaarangan/stepgate/issues/new?template=stepfile_idea.yml).

## Documentation

- [docs/stepfile.md](docs/stepfile.md): how to write a stepfile: fields, tools, credentials, steps and gates.
- [docs/how-it-works.md](docs/how-it-works.md): what Stepgate does during a run, its limits, errors and ledger.
- [server/schema/stepfile.schema.json](server/schema/stepfile.schema.json): the JSON Schema for stepfiles.
- [CONTEXT.md](CONTEXT.md): the project's vocabulary.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE)
