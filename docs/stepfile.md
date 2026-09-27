# Writing a stepfile

A stepfile is one YAML or JSON file that describes an agent's procedure: its inputs, the remote APIs and MCP servers it may call, and an ordered list of steps with the checks each step must pass. It names no model, provider or framework, so the same file runs on any MCP client.

The JSON Schema is [server/schema/stepfile.schema.json](../server/schema/stepfile.schema.json), and [stepfiles/marketing/market-research](../stepfiles/marketing/market-research/) is a complete example from the [catalog](../stepfiles/). Name files `<id>.stepfile.yaml`. To run your own file, pass its path to `stepgate`, as [connect.md](connect.md#your-own-stepfiles) describes; it does not need to be in the catalog. For what Stepgate does when it runs one, see [how-it-works.md](how-it-works.md).

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
7. A step has `instructions` or `do`, not both. An agent step has at least one gate; a mechanical step has no `tools`, `retries`, `derive` or `let`, its call ids are unique, every call names an exposed operation, and `responses.<id>` names an earlier call of the step, or any of its calls in `output`.
8. Every `derive` key is a property of the step's `produces`.
9. Every `var` path under `let.` names an entry of the step's `let`, one before it when read from `let` itself, and `when` reads no `let`.
10. Every `results` takes a literal operation name and optional path, and appears only in an agent step's gates, `let` and `derive`, never in `when`, `select` or `do`.
11. Every expression is made of one-key objects naming a JSONLogic or Stepgate operator, and empty objects. An object with other keys would be kept as data unevaluated, so it is refused; build it with `object`, or in a template write it as it is.

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

An `exposes` entry may also be an object with a `select`: a JSONLogic expression over the operation's result (parsed as JSON where it is JSON), whose value is all the client is shown. Gates still see the whole result in `calls`, so a large response can be narrowed to the fields a step needs without the model losing evidence to truncation or the gates losing what the API returned. An error result is shown whole.

```yaml
exposes:
  - name: searchBooks
    select: { map: [{ var: docs }, { cat: [{ var: key }, " ", { var: title }] }] }
```

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
    token_url: https://api.notion.com/v1/oauth/token   # oauth2 only, optional
    hosts: [api.notion.com]
    description: Reads the target database. Never writes.
```

A stepfile declares what it needs and never where a secret lives: there is no value field and no environment-variable name. Whoever runs Stepgate supplies the value, as `<NAME>_API_KEY` in its environment. A `basic` credential's value is `user:secret`, for example an Atlassian or Zendesk email and API token, and is sent as HTTP Basic. `description` is required; it is what a person reads before handing the stepfile a credential.

An `oauth2` credential with a `token_url` can also be refreshed: whoever runs Stepgate sets `<NAME>_REFRESH_TOKEN` and `<NAME>_CLIENT_ID` (and `<NAME>_CLIENT_SECRET` for a confidential client) instead of an access token, and Stepgate exchanges them at `token_url` with the declared `scopes`, refreshes the access token before it expires, and once more when an API answers 401. The refresh token is sent to `token_url`, so it is fixed in the file and cannot use a `{setting}`; read it before handing a stepfile a refresh token.

A remote MCP server that uses MCP authorization, such as Linear's or Notion's, takes an `oauth2` credential whose `token_url` is the token endpoint its authorization server advertises; `stepgate_inspect_api` reports it. Before reading such a credential, Stepgate reads the server's protected resource metadata and refuses to start if its authorization server advertises a different token endpoint, so a refresh token only goes where the MCP server says. Whoever runs Stepgate authorizes it once with `stepgate --auth`, as [connect.md](connect.md#mcp-servers-that-use-mcp-authorization) describes.

A credential is attached only to requests whose host is in its `hosts`, and never reaches the model, a placeholder or the ledger.

## Steps

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Identifier |
| `instructions` | one of the two | What the model should do, with placeholders; makes this an agent step |
| `do` | one of the two | Calls and an output Stepgate makes itself; makes this a mechanical step ([Mechanical steps](#mechanical-steps)) |
| `tools` | no | Exposed tool names this step may call; omitted means none |
| `produces` | yes | JSON Schema the step's output must satisfy |
| `gates` | agent steps | At least one gate; optional on a mechanical step |
| `retries` | no | Extra attempts after a gate fails, 0 to 5; default 0 |
| `derive` | no | Output fields Stepgate computes after the client submits ([Deriving fields](#deriving-fields)) |
| `let` | no | Named JSONLogic expressions that gates read as `let.<name>` ([Naming expressions](#naming-expressions)) |
| `when` | no | A predicate over `inputs` and `steps`; the step is skipped unless it is `true` |

Steps run in file order. There is no branching, looping or parallel block; `when` covers optional steps. An agent step is done by the client's agent; a mechanical step by Stepgate, and the client is never shown it.

**Placeholders.** `{{inputs.<path>}}` and `{{steps.<id>.<path>}}` are replaced in `instructions` before the step starts. A string is inserted as-is and anything else as indented JSON. Placeholders work only in `instructions` and have no conditionals, loops or filters. A path that cannot be resolved is an error, caught at load time where possible.

**Submitting.** The client finishes a step by sending an output matching `produces` to Stepgate's `stepgate_submit` tool. Each submission is one attempt.

### Mechanical steps

A step with `do` instead of `instructions` is done by Stepgate. It makes each call in `calls` in order, computes `output`, checks it against `produces` and any gates, and moves on. The client is never shown the step; the next step it is shown lists it under `completed`. Use one for work that needs no judgement: fetching what the inputs already name, picking the latest filing, arithmetic.

```yaml
- id: fetch
  do:
    calls:
      - id: shelf
        operation: listItems
        arguments: { shelf: { var: inputs.shelf } }
    output:
      ids: { map: [{ var: responses.shelf.items }, { var: id }] }
      count: { length: { var: responses.shelf.items } }
  produces:
    type: object
    required: [ids, count]
    properties: { ids: { type: array }, count: { type: integer } }
```

A call's `operation` is any exposed name, and its `arguments` and the step's `output` are templates over `{ inputs, steps, responses }`, where `responses.<call id>` is an earlier call's full result, parsed as JSON when it is JSON. In a template:

- a one-key object whose key is a JSONLogic or Stepgate operator is an expression, and its value is used;
- `{ literal: <value> }` is the value as written, for an object that would otherwise read as an expression, such as a request body `{ filter: ... }`;
- any other object or array has each member evaluated as a template, and anything else is itself.

Templates build objects at their own level only. Inside an expression, such as the body of a `map`, build each item with `object`:

```yaml
output:
  rows: { map: [{ var: responses.shelf.items }, { object: [[name, { var: id }], [stock, { var: count }]] }] }
```

A call with `each`, an expression giving an array, is made once per element in order, with the element as `item` in its `arguments`, and `responses.<call id>` is then the list of results. An empty array makes no request. This repeats one call over data, such as looking up every DOI an earlier step listed; it is not a loop over steps, which the format does not have.

```yaml
calls:
  - id: works
    operation: getWork
    each: { var: steps.parse.dois }
    arguments: { doi: { var: item } }
```

Some APIs answer a question with an error status: NHTSA answers 400 when a vehicle has no recalls, and a registry 404 when a package does not exist. A call's `accept` lists the statuses of an OpenAPI operation to keep as its response, parsed like any other, instead of stopping the run:

```yaml
- { id: recalls, operation: getRecallsByVehicle, arguments: { ... }, accept: [400] }
```

A mechanical step takes no `tools`, `retries`, `derive` or `let`, and `results` has no calls to read there. Nobody is there to retry, so a call whose arguments break the operation's schema stops the run with `CallArgumentsInvalid`, a call that returns an error its `accept` does not list with `ToolCallFailed`, and an output that fails `produces` or a gate with `GateFailed`. Its calls count against the call limit like the client's.

### Deriving fields

Counting, picking the latest item, arithmetic and copying are work a model does slowly and gets wrong, and checking that it did them right takes a gate. A step's `derive` has Stepgate compute such fields instead. Each key is a top-level property of `produces`, and each value a JSONLogic expression over what gates see, with `output` being the client's submission:

```yaml
produces:
  type: object
  required: [ids, count]
  properties:
    ids: { type: array, items: { type: string } }
    count: { type: integer }
derive:
  count: { length: { results: [listItems, items] } }
```

The client is shown `produces` without the derived properties and their `required` entries, and a submission that includes one fails a gate named `derive`. Otherwise Stepgate checks the submission against that reduced schema, evaluates `let`, adds the derived fields and checks the result against the whole `produces`. Gates, later steps and the run's outputs see the output with the derived fields, and `let` sees the submission without them.

## Gates

A gate is a mechanical check on the submitted output, or a person's approval of it. Every gate blocks; there are no advisory gates and no gates judged by a model.

Gates see `{ inputs, steps, output, calls, let }`: the run's inputs, each earlier step's accepted output under `steps.<id>`, the submission being checked as `output`, `calls`, every tool call this step has made, and the step's `let` values. The output is validated against `produces` first; a mismatch fails like a gate.

Each entry in `calls` is `{ tool, arguments, result, is_error }`, where `tool` is the exposed name and `result` is the tool's full response, parsed as JSON when it is JSON and kept as text otherwise. Calls refused or rejected for bad arguments never reached the tool and are not listed. `calls` is what lets a gate catch a fabricated value: it can check that what the model submitted is what an API actually returned.

**`schema`** checks `output` against a JSON Schema (2020-12). The validator's errors are the diagnosis.

```yaml
- id: enough-sources
  schema: { properties: { sources: { minItems: 12 } } }
```

**`predicate`** evaluates a [JSONLogic](https://jsonlogic.com/operations.html) rule and passes only if it returns exactly `true`. Its `message` is the diagnosis the model sees on failure. An optional `explain` is a second JSONLogic expression, evaluated only when the rule fails, whose result is added after the message, so the model is told which items broke the rule instead of guessing. A `null`, empty string or empty array adds nothing, and the addition is cut at 2,000 characters. Without an `explain`, the predicates listed under [When a gate fails](#when-a-gate-fails) explain themselves.

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

`results` is shorthand for the filter over `calls` that evidence gates need, and it leaves out calls whose `is_error` is true. The rule above, leaving out failed searches, is:

```yaml
  predicate:
    subset:
      - { map: [{ var: output.books }, { var: key }] }
      - { map: [{ results: [searchBooks, docs] }, { var: key }] }
```

Like `var: calls`, it reads the step's calls from the top of the data, so use it where `var: calls` would work, not inside the body of a `map`, `filter` or `all`.

For a `subset` rule, `difference` over the same two arrays makes a good `explain`. This one lists the books no search returned:

```yaml
  explain:
    difference:
      - { map: [{ var: output.books }, { var: key }] }
      - flatten:
          map:
            - filter: [{ var: calls }, { "==": [{ var: tool }, searchBooks] }]
            - map: [{ var: result.docs }, { var: key }]
```

Besides the standard JSONLogic operators, thirteen more are available:

| Operator | Arguments | Result |
|---|---|---|
| `results` | operation, optional path | The values at `path` (the whole result without one) of every call this step made to the operation that did not fail, flattened one level |
| `object` | `[key, value]` pairs | An object with those keys and values, each value evaluated, or `null` if a key is not a string; the only way to build one inside `map`, since JSONLogic keeps an object literal as data |
| `length` | array or string | Number of elements, or of Unicode code points |
| `unique` | array | Distinct elements by JSON equality, in first-seen order |
| `subset` | array `a`, array `b` | `true` if every element of `a` is in `b` |
| `difference` | array `a`, array `b` | The elements of `a` that are not in `b`, in order |
| `keys` | object | Its own keys, in order; `null` if not an object. APIs that omit empty fields, such as Airtable, make this the list of filled fields |
| `lower` | string | The string in lowercase, for case-insensitive comparisons |
| `get` | object or array, key | The value under one key, read literally; use it for keys that contain dots, such as email addresses, which `var` cannot reach |
| `join` | array `left`, array `right`, path `l`, path `r` | Each item of `left` as `{ left, right }`, where `right` is the first item of `right` whose value at `r` equals the left item's value at `l`, or `null` |
| `flatten` | array | The array with nested arrays flattened one level |
| `host` | string | Lowercased host of an absolute URL, with port if present; `null` if not a URL |
| `match_all` | string, pattern | Capture group 1 of every match, or the whole match if the pattern has no group |

`subset`, `difference` and `join` exist because JSONLogic's `all`, `map` and `filter` cannot see data outside the current array element. `subset` answers "is every cited id a kept source"; `join` lines each output row up with its evidence so a rule can compare them field by field, for example `none` over `join(output.rows, calls.0.result.items, "id", "id")` of rows whose `right` is `null` or whose `left.stock` differs from `right.stock`. Note that JSONLogic's `all` is false on an empty array; use `none`, or a count of violations, when the list may be empty. Patterns in `match_all`, in a setting's `pattern`, and in the `pattern` and `patternProperties` keywords of `inputs`, `produces`, `$defs` and `schema` gates run on RE2, which matches in time linear in the input, so no pattern can stall a run on a large API response. RE2 accepts the ECMA-262 subset JSON Schema recommends plus lookbehind, but not lookahead or backreferences; a pattern it cannot compile fails at load time. End a match with a consumed group such as `(?:[^0-9]|$)` where you would write `(?![0-9])`. Schemas published by a remote tool keep their own patterns, since they only check the client's arguments.

**`http`** posts `{ stepfile, step, gate, inputs, steps, output, calls }` as JSON, without the step's `let` values, to a `verifier` tool. A 2xx response of `{ "pass": true }` passes; `{ "pass": false, "message": "..." }` fails with that message. Any other response is treated as an outage rather than a verdict and stops the run. This is how a check that needs code runs: you operate the verifier.

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

**`approve`** asks a person. Stepgate sends the client an MCP [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) with the gate's `message` and the submitted output beneath it; the gate passes when the person accepts, and fails with their reason, which the model sees, when they decline. Put it on the step before anything irreversible, such as sending the email a draft step prepared. A run whose stepfile has an `approve` gate fails preflight on a client that does not support elicitation.

```yaml
- id: reviewed
  approve: { message: Send this email to the customer list? }
```

It is still mechanical: a person decides, never a model. How long Stepgate waits for the answer is `--run-idle-ms`.

### Naming expressions

A step's `let` names expressions once, so a predicate and its `explain`, or several gates, do not repeat the same one. The entries are evaluated in order on every submission that satisfies `produces`, over what gates see, and each may read the ones before it. Gates read them as `let.<name>`:

```yaml
let:
  cited: { unique: { var: output.cited } }
  unknown: { difference: [{ var: let.cited }, { var: inputs.sources }] }
gates:
  - id: known-sources
    message: "Cite only the given sources; these are not among them:"
    predicate: { "==": [{ length: { var: let.unknown } }, 0] }
    explain: { var: let.unknown }
```

## Testing gates offline

`stepgate --test <stepfile> [<cases.yaml>]` runs a stepfile's gates over recorded calls and outputs, with no model and no network, and exits 1 when a verdict differs from what the case expects. The cases default to `<id>.cases.yaml` beside the stepfile, and the catalog's CI runs every entry's cases.

```yaml
cases:
  - name: a doc no search returned is rejected
    inputs: { books: [{ title: Dune, author: Frank Herbert }] }
    steps:
      - step: search
        calls:                        # what the step's operations returned, as gates see them in calls
          - tool: searchByTitleAndAuthor
            arguments: { title: Dune, author: Frank Herbert, limit: 5 }
            result: { docs: [{ key: /works/OL893415W, title: Dune, author_name: [Frank Herbert] }] }
        output: { books: [...] }      # what the step submits
        expect: { fail: [docs-match-searches] }   # or: pass
```

Rather than write the recorded calls by hand, run Stepgate with `--record-cases <dir>`: every run that finishes or fails is written there in this format, one entry per attempt with the calls the step had made, what it submitted and which gates failed. The file holds the APIs' full responses, so trim them to what the gates read and remove anything personal before committing it.

Steps run in the order listed, and a step expected to `pass` becomes `steps.<id>` for the ones after it. `http` gates need their verifier and `approve` gates a person, so both are skipped and named in the report. [media/book-list-verification](../stepfiles/media/book-list-verification/) has a complete cases file.

## When a gate fails

The model gets back every failing gate's id and diagnosis as the result of its `stepgate_submit` call, and may submit again. A predicate with no `explain` adds what broke after its `message` when its rule has one of these shapes:

| Rule | Added |
|---|---|
| `subset: [a, b]` | The `difference` of `a` and `b`: the items of `a` not in `b` |
| `none: [{ join: ... }, condition]` | The `left` item of every pair that met the condition |
| `==` or `===` of two values | `expected <second>, got <first>`, so put the submitted value first |
| `and` of rules | What each failing part of the shapes above adds, separated by ` \| ` |

An `explain` replaces this, and any other shape shows only its `message`. Once a step has used its `retries`, the run stops with `GateFailed`. A step also stops at the tool-call limit whoever runs Stepgate has set.

## Identity

A stepfile's identity is `sha256:` plus the SHA-256 of its RFC 8785 canonical JSON form, so the YAML and JSON forms of one file share an identity. Every run records the identity of the file it ran.
