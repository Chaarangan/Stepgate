# Writing a stepfile

A stepfile is one YAML or JSON file that describes an agent's procedure: its inputs, the remote APIs and MCP servers it may call, and an ordered list of steps with the checks each step must pass. It names no model, provider or framework, so the same file runs on any MCP client.

The JSON Schema is [server/schema/stepfile.schema.json](../server/schema/stepfile.schema.json), and [stepfiles/marketing/market-research](../stepfiles/marketing/market-research/) is a complete example from the [catalog](../stepfiles/). Name files `<id>.stepfile.yaml`. For what Stepgate does when it runs one, see [how-it-works.md](how-it-works.md).

The format version is `"1"`. It is a draft, so fields may still change before a stable release.

## Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `stepgate` | yes | Format version, `"1"` |
| `id` | yes | Lowercase identifier; it becomes the MCP tool name |
| `title`, `description` | no | Human-facing text; `description` becomes the tool description |
| `inputs` | yes | JSON Schema (2020-12) with `type: object`; it becomes the tool's input schema |
| `settings` | no | Values whoever runs Stepgate supplies, such as a customer's site name ([Settings](#settings)) |
| `credentials` | no | Secrets the tools need, by name ([Credentials](#credentials)) |
| `tools` | no | Remote APIs and MCP servers the steps may call, keyed by lowercase hyphenated names such as `jira-cloud` ([Tools](#tools)) |
| `steps` | yes | The steps, run in order ([Steps](#steps)) |
| `$defs` | no | Shared JSON Schemas, referenced as `#/$defs/<name>` |

Unknown fields are rejected. Beyond the schema, Stepgate checks these rules when it loads a file, and refuses to start if one fails:

1. Step ids are unique, and gate ids are unique within a step.
2. Every name in any `exposes` list is unique across the file, and none is `submit`.
3. Every name in a step's `tools` is an exposed name.
4. Every `credential` a tool names is declared, and the tool's host is in that credential's `hosts`.
5. Every `http` gate names a `verifier` tool.
6. Every placeholder and every `var` path under `steps.` names an earlier step.

## Tools

Tools are remote. Every URL is `https`, except that plain `http` is accepted for a loopback address (`localhost`, `127.0.0.1`, `[::1]`) so local verifiers and test servers work. A stepfile cannot run local code or launch a stdio MCP server.

**`openapi`** gives the `server` URL Stepgate calls, an OpenAPI 3.x document inline (`document`) or by `url` plus `sha256` (the SHA-256 of the fetched bytes), and the `operationId`s it `exposes`. The document's own `servers` list is ignored, so the host a tool reaches is always visible in the stepfile. Each exposed operation becomes one tool built from its parameters and JSON request body. Operations not exposed are invisible to the model.

```yaml
tools:
  notion:
    openapi:
      server: https://api.notion.com/v1
      url: https://example.com/notion-openapi.yaml
      sha256: "sha256:<hex digest of the document>"
    credential: notion
    exposes: [queryDatabase, createPage]
```

**`mcp`** gives a Streamable HTTP MCP server `url` and the tool names it `exposes`. An entry may pin `schema_sha256`, the SHA-256 of the RFC 8785 canonical form of that tool's input schema, so a changed signature is caught before the run starts.

```yaml
tools:
  tavily:
    mcp: { url: "https://mcp.tavily.com/mcp/" }
    credential: tavily
    exposes: [tavily_search]
```

**`verifier`** gives a `url` that `http` gates post to. It exposes nothing to the model.

Exposed names match `^[a-zA-Z0-9_-]{1,64}$`, which the major model APIs accept as tool names. A tool binds at most one credential. An MCP tool takes a `bearer` or `oauth2` credential, sent as an `Authorization: Bearer` header. An OpenAPI tool places its credential where the operation's security scheme says, and always as HTTP Basic for a `basic` credential.

An OpenAPI parameter whose schema allows exactly one value (`const`, or an `enum` with one entry) is sent with that value on every call and is not shown to the model. Use it for fixed headers and query values an API requires, such as `format: json`.

An array query parameter is sent the way OpenAPI specifies by default, repeating the name (`tag=red&tag=blue`); with `explode: false` it is sent comma-separated (`fields=name,stock`). A request body is sent as JSON when the operation accepts `application/json`. Otherwise, for a `text/*` or `message/*` content type, the model supplies the body as a plain string and Stepgate sends it with that content type, which is how a raw email reaches Gmail's `message/rfc822` upload without any encoding by the model.

## Settings

Some services live at a different host for every customer: `acme.atlassian.net`, `acme.service-now.com`, `acme.zendesk.com`. A stepfile declares such a value as a setting and uses it as `{name}` in the host of a tool URL and in credential `hosts`:

```yaml
settings:
  jira-site:
    description: Your Atlassian site name, the "acme" in acme.atlassian.net.
tools:
  jira:
    openapi:
      server: https://{jira-site}.atlassian.net/rest/api/3
      document: { ... }
    credential: jira
    exposes: [searchIssues]
credentials:
  jira:
    kind: basic
    hosts: ["{jira-site}.atlassian.net"]
    description: Your Atlassian email and an API token, as you@example.com:token.
```

Whoever runs Stepgate supplies the value as an environment variable named after the setting, `JIRA_SITE=acme` here. It is filled in before the run starts, so the hosts Stepgate may contact are fixed and known before the model is asked anything. The value must match the setting's `pattern`, which defaults to a single DNS label (letters, digits and hyphens), so it cannot point a request at another host. Placeholders are allowed only in the host and port, never in a path, and every placeholder must be a declared setting that some tool or credential uses.

## Credentials

```yaml
credentials:
  notion:
    kind: oauth2               # api_key | bearer | oauth2 | basic
    scopes: [read_content]     # required for oauth2, not allowed otherwise
    hosts: [api.notion.com]
    description: Reads the target database. Never writes.
```

A stepfile declares what it needs and never where a secret lives: there is no value field and no environment-variable name. Whoever runs Stepgate supplies the value, as `<NAME>_API_KEY` in its environment. A `basic` credential's value is `user:secret`, for example an Atlassian or Zendesk email and API token, and is sent as HTTP Basic. `description` is required; it is what a person reads before handing the stepfile a credential.

A credential is attached only to requests whose host is in its `hosts`, and never reaches the model, a placeholder or the ledger.

## Steps

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Identifier |
| `instructions` | yes | What the model should do, with placeholders |
| `tools` | no | Exposed tool names this step may call; omitted means none |
| `produces` | yes | JSON Schema the step's output must satisfy |
| `gates` | yes | At least one gate |
| `retries` | no | Extra attempts after a gate fails, 0 to 5; default 0 |
| `when` | no | A predicate over `inputs` and `steps`; the step is skipped unless it is `true` |

Steps run in file order. There is no branching, looping or parallel block; `when` covers optional steps.

**Placeholders.** `{{inputs.<path>}}` and `{{steps.<id>.<path>}}` are replaced in `instructions` before the step starts. A string is inserted as-is and anything else as indented JSON. Placeholders work only in `instructions` and have no conditionals, loops or filters. A path that cannot be resolved is an error, caught at load time where possible.

**Submitting.** Every step gets one extra tool, `submit`, whose input schema is `produces`. The model finishes a step by calling it. A turn that ends without calling `submit` counts as a failed attempt, and the model is asked to call it.

## Gates

A gate is a mechanical check on the submitted output. Every gate blocks; there are no advisory gates and no gates judged by a model.

Gates see `{ inputs, steps, output, calls }`: the run's inputs, each earlier step's accepted output under `steps.<id>`, the submission being checked as `output`, and `calls`, every tool call this step has made. The output is validated against `produces` first; a mismatch fails like a gate.

Each entry in `calls` is `{ tool, arguments, result, is_error }`, where `tool` is the exposed name and `result` is the tool's full response, parsed as JSON when it is JSON and kept as text otherwise. Calls refused or rejected for bad arguments never reached the tool and are not listed. `calls` is what lets a gate catch a fabricated value: it can check that what the model submitted is what an API actually returned.

**`schema`** checks `output` against a JSON Schema (2020-12). The validator's errors are the diagnosis.

```yaml
- id: enough-sources
  schema: { properties: { sources: { minItems: 12 } } }
```

**`predicate`** evaluates a [JSONLogic](https://jsonlogic.com/operations.html) rule and passes only if it returns exactly `true`. Its `message` is the diagnosis the model sees on failure.

```yaml
- id: domain-breadth
  message: Sources must span at least six distinct domains.
  predicate:
    ">=":
      - { length: { unique: { map: [{ var: output.sources }, { host: { var: url } }] } } }
      - 6
```

A predicate can check the output against the evidence. This one passes only if every book the model lists was returned by one of its `searchBooks` calls:

```yaml
- id: books-exist
  message: Every book must come from an Open Library search result.
  predicate:
    subset:
      - { map: [{ var: output.books }, { var: key }] }
      - flatten:
          map:
            - filter: [{ var: calls }, { "==": [{ var: tool }, searchBooks] }]
            - map: [{ var: result.docs }, { var: key }]
```

Besides the standard JSONLogic operators, nine more are available:

| Operator | Arguments | Result |
|---|---|---|
| `length` | array or string | Number of elements, or of Unicode code points |
| `unique` | array | Distinct elements by JSON equality, in first-seen order |
| `subset` | array `a`, array `b` | `true` if every element of `a` is in `b` |
| `lower` | string | The string in lowercase, for case-insensitive comparisons |
| `get` | object or array, key | The value under one key, read literally; use it for keys that contain dots, such as email addresses, which `var` cannot reach |
| `join` | array `left`, array `right`, path `l`, path `r` | Each item of `left` as `{ left, right }`, where `right` is the first item of `right` whose value at `r` equals the left item's value at `l`, or `null` |
| `flatten` | array | The array with nested arrays flattened one level |
| `host` | string | Lowercased host of an absolute URL, with port if present; `null` if not a URL |
| `match_all` | string, pattern | Capture group 1 of every match, or the whole match if the pattern has no group |

`subset` and `join` exist because JSONLogic's `all`, `map` and `filter` cannot see data outside the current array element. `subset` answers "is every cited id a kept source"; `join` lines each output row up with its evidence so a rule can compare them field by field, for example `none` over `join(output.rows, calls.0.result.items, "id", "id")` of rows whose `right` is `null` or whose `left.stock` differs from `right.stock`. Note that JSONLogic's `all` is false on an empty array; use `none`, or a count of violations, when the list may be empty. Use the ECMA-262 regex subset that JSON Schema recommends in `match_all` and `pattern`, so a pattern behaves the same in your editor and in Stepgate.

**`http`** posts `{ stepfile, step, gate, inputs, steps, output, calls }` as JSON to a `verifier` tool. A 2xx response of `{ "pass": true }` passes; `{ "pass": false, "message": "..." }` fails with that message. Any other response is treated as an outage rather than a verdict and stops the run. This is how a check that needs code runs: you operate the verifier.

```yaml
tools:
  checker:
    verifier: { url: "https://verify.example.com/citations" }
steps:
  - id: report
    gates:
      - id: citations-resolve
        http: { tool: checker }
```

## When a gate fails

The model gets back every failing gate's id and diagnosis as the result of its `submit` call, in the same conversation, and may submit again. Once a step has used its `retries`, the run stops with `GateFailed`. A step also stops at the turn limit whoever runs Stepgate has set.

## Identity

A stepfile's identity is `sha256:` plus the SHA-256 of its RFC 8785 canonical JSON form, so the YAML and JSON forms of one file share an identity. Every run records the identity of the file it ran.
