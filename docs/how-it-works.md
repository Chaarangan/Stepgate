<a id="top"></a>

<p><a href="../README.md">Stepgate</a> &middot; <a href="stepfile.md">Writing a stepfile</a> &middot; <a href="connect.md">Connecting a client</a> &middot; <strong>How it works</strong></p>

# How Stepgate works

Stepgate is an MCP server. It offers each stepfile it loads as a tool.

When a client calls that tool, Stepgate starts a run and shows the client's agent the first step. The agent does the step with its own model, through Stepgate's tools. Stepgate decides when the step has passed.

For the file format itself, see [stepfile.md](stepfile.md). For connecting a client, see [connect.md](connect.md).

<details>
  <summary>Contents</summary>
  <ol>
    <li><a href="#one-step-at-a-time">One step at a time</a></li>
    <li><a href="#connecting-a-client">Connecting a client</a></li>
    <li>
      <a href="#during-a-run">During a run</a>
      <ul>
        <li><a href="#preflight">Preflight</a></li>
        <li><a href="#evidence">Evidence</a></li>
        <li><a href="#isolation">Isolation</a></li>
        <li><a href="#tool-calls">Tool calls</a></li>
        <li><a href="#credentials">Credentials</a></li>
        <li><a href="#retries">Retries</a></li>
      </ul>
    </li>
    <li><a href="#limits">Limits</a></li>
    <li><a href="#errors">Errors</a></li>
    <li><a href="#the-ledger">The ledger</a></li>
    <li><a href="#design-choices">Design choices</a></li>
  </ol>
</details>

## One step at a time

The client never holds the stepfile. Stepgate reads it and shows the client one step at a time, with only that step's instructions, operations and output schema:

```
client → stepgate-tool(inputs)      stepgate preflights every credential and tool
stepgate → client   run id, step 1 instructions, operations, output schema
client → stepgate_call(operation)   stepgate makes the request, returns the result
client → stepgate_submit(output)    stepgate checks step 1 gates → fail: diagnosis back to client
client → stepgate_submit(output)    stepgate checks step 1 gates → pass
stepgate → client   step 2 instructions only
```

This design rules out three things:

- **Skipping a step.** The client is not told step 2 exists until step 1 passes.
- **Declaring a step done.** A step passes only when its gates pass over the output the client submitted.
- **Reaching an undeclared host or reading a key.** Stepgate makes every request itself.

A mechanical step is one with `do` instead of instructions. It never reaches the client. Stepgate makes its calls, computes its output and checks its gates itself, and the next step the client is shown lists it under `completed`.

A run may start or end with mechanical steps. A run of only mechanical steps finishes on the call that starts it.

The guarantee is that the path through a stepfile depends only on submitted outputs and mechanical checks. The outputs themselves still come from a model and still vary.

<p align="right">(<a href="#top">back to top</a>)</p>

## Connecting a client

`stepgate <stepfile>...` serves over stdio, which is how desktop MCP clients launch servers. Each argument is one of:

- a path ending in `.yaml`, `.yml` or `.json`;
- the name of a stepfile in the bundled [catalog](../awesome-stepfiles/). `stepgate --list` shows the catalog.

`--http <port>` serves Streamable HTTP at `/mcp` instead.

Every file is loaded and validated at start, so an invalid stepfile stops the server rather than failing a call. The client needs nothing beyond MCP tools, so any MCP client with a model that can call tools works.

- **Listing.** Each stepfile is one tool: `id` is its name, `description` its description, and `inputs` its input schema. Two more tools, `stepgate_call` and `stepgate_submit`, drive runs. The server's instructions tell the agent how.
- **Starting.** Calling a stepfile's tool runs preflight, then returns the run id and the first step:
  - its instructions, with placeholders filled in;
  - the operations it may call, with their argument schemas;
  - the output schema;
  - how many attempts it has.

  The calling agent supplies inputs only. It cannot add or change credentials.
- **Calling.** `stepgate_call` takes the run id, an operation the current step lists, and its arguments. It returns the operation's result.
- **Submitting.** `stepgate_submit` takes the run id and the step's output. It returns one of:
  - the next step;
  - the failing gates' diagnoses, with the attempts left;
  - after the last step, `{ identity, outputs }`, holding every step's accepted output.
- **Results.** Every response carries the same information as text and as `structuredContent`, because some clients show only one of the two. `structuredContent` is `{ run, state, ... }`, where `state` is `running`, `finished` or `failed`. A response that ends a run starts with the error type.
- **Authoring.** `stepgate_guide`, `stepgate_examples`, `stepgate_outline`, `stepgate_inspect_api`, `stepgate_validate` and `stepgate_try` help an agent write a new stepfile and try it without restarting the server. [connect.md](connect.md#writing-stepfiles-with-an-agent) describes them. With no stepfile arguments, Stepgate serves only these.
- **HTTP.** `--http` listens on 127.0.0.1 only. It refuses:
  - a request whose `Host` or `Origin` is not a loopback address, so a web page cannot reach it through DNS rebinding;
  - a request body larger than 4 MiB, with 413;
  - a body that is not JSON, with 400.
- **Runs.** A run belongs to the MCP session that started it, so HTTP sessions are stateful.
  - A session idle for `--run-idle-ms` is closed with its runs.
  - A run the client stops calling for `--run-idle-ms` is abandoned and its connections closed. Later calls for it get `RunNotActive`.

<p align="right">(<a href="#top">back to top</a>)</p>

## During a run

### Preflight

Before step 1, Stepgate checks everything the run needs:

1. It fills in the stepfile's settings from its environment (setting `jira-site` from `JIRA_SITE`) and checks each value against its pattern.
2. It validates the inputs.
3. It checks that every declared credential is set.
4. It fetches each OpenAPI document and checks its digest and exposed operations.
5. It connects to each MCP server and checks its exposed tools and pinned schemas.

For an MCP tool whose credential has a `token_url`, Stepgate first checks that token endpoint against the one the server's authorization server advertises. This happens before any credential is read.

Any failure stops the run with `PreflightFailed`, naming what failed, before the client is shown any step.

### Evidence

Every call a step makes is kept for that step's gates as `calls`, with its arguments and full result. A gate can then check the submitted output against what the APIs really returned.

A client that fetches data some other way, with its own tools, cannot pass an evidence gate with it.

Evidence is held in memory only. The ledger records hashes, not results.

### Isolation

The client sees only the current step's instructions, with placeholders filled in. It never sees the stepfile, the list of steps, or a later step's instructions.

Its own conversation still holds earlier steps. A step's instructions should therefore say what to use, rather than rely on the agent forgetting.

### Tool calls

Stepgate makes every call itself, one at a time per run, even when the client sends several at once.

- **Arguments.** Stepgate checks them against the operation's schema first, and returns any mismatch to the client as an error.
- **User-Agent.** Every request carries `User-Agent: stepgate/<version>`, followed by the `--contact` email when one is set.
- **Hosts.** Stepgate refuses any request to a host no tool declares (`EgressDenied`). It follows redirects itself, so the same check applies to every hop.
- **Credentials.** A credential goes only to hosts in its `hosts`.
- **Exceptions to the host check.** Two requests go to hosts no tool declares, and neither carries a credential:
  - fetching an OpenAPI document from its declared `url` during preflight;
  - reading an MCP server's authorization metadata from the host of its credential's `token_url`.
- **Time and size.** Every request must finish within `--request-timeout-ms`, body included. A response larger than `--response-bytes` stops the run with `ResponseTooLarge`.
- **Paths.** Path parameters are percent-encoded, so no argument can change the host.

Tool results reach the client as data.

### Credentials

Credential `<name>` is read from `<NAME>_API_KEY` in Stepgate's environment, which an MCP client sets in its server configuration. A value is read when a request needs it and kept no longer than that request.

An `oauth2` credential with a `token_url` may instead be given `<NAME>_REFRESH_TOKEN` and `<NAME>_CLIENT_ID`. Stepgate then:

- holds the access token in memory until 60 seconds before it expires;
- refreshes it when an API answers 401, and sends the request once more;
- keeps a rotated refresh token in memory, since it cannot rewrite the environment.

A revoked refresh token stops the run with `InvalidGrant`.

### Retries

Calls to tools, verifiers and OpenAPI documents are retried up to four times.

**What is retried:**

- a 429;
- a 403 that carries rate-limit headers the way GitHub sends them;
- a 5xx, a network error or a missed deadline, but only for GET, HEAD, OPTIONS, PUT and DELETE, and for an operation the stepfile declares `effect: read`.

**What is not retried:**

- A POST or PATCH that fails. It may already have taken effect, so it fails at once with `ToolCallFailed` rather than risk sending an email or creating an issue twice.
- An OAuth `invalid_grant`. It stops the run at once with `InvalidGrant`, because a revoked grant will not recover and retrying can revoke a working one.

**How long Stepgate waits:**

- When the response says how long (`Retry-After`, or `x-ratelimit-remaining: 0` with `x-ratelimit-reset`), Stepgate waits that long.
- Otherwise it backs off, starting from half a second.
- An API asking for more than 60 seconds ends the call at once with `ToolCallFailed`.

Each retry leaves a `retry` record with the wait. After the last attempt, the last error is raised.

<p align="right">(<a href="#top">back to top</a>)</p>

## Limits

Limits depend on the client and its model, so they are command-line options rather than stepfile fields:

| Option | Default | Meaning |
|---|---|---|
| `--calls-per-step` | 100 | Most `stepgate_call` calls one step may make, across all attempts (`CallLimitReached`) |
| `--tool-result-chars` | 20000 | Longest tool result passed to the client; longer results are cut and end with a visible `[truncated: …]` note |
| `--run-idle-ms` | 1800000 | How long a run waits for the client's next call before it is abandoned |
| `--request-timeout-ms` | 60000 | How long one outgoing request may take, body included; an MCP server's event stream has no deadline |
| `--response-bytes` | 10485760 | Largest response Stepgate reads from a tool, verifier or OpenAPI document (`ResponseTooLarge`) |
| `--ledger-dir` | none | Write one ledger file per run here, as `<stepfile>-<run>.jsonl`; otherwise records go to standard error |
| `--contact` | none | Your contact email, sent in the User-Agent; SEC EDGAR and USAJOBS require one |
| `--draft-credential` | none | `<name>=<host>[,<host>...]`: let drafts use this credential, sent only to these hosts; repeatable |
| `--draft-setting` | none | Let drafts use this setting from the environment; repeatable |
| `--record-cases` | none | Write each finished or failed run here as `<stepfile>-<run>.cases.yaml`, which `stepgate --test` runs; the file holds the APIs' full responses, and a run that ended before any attempt writes none |
| `--watch` | off | Reload a stepfile when its file changes; a run in progress keeps the version it started with |

<p align="right">(<a href="#top">back to top</a>)</p>

## Errors

| Error | Meaning |
|---|---|
| `StepfileInvalid` | The file failed the schema or a load-time rule; carries each issue's path |
| `StepfileUnreadable` | With `--watch`, a served stepfile's file could not be read, as when it was removed |
| `PreflightFailed` | A check before step 1 failed; names the `item` (`inputs`, `setting <name>`, `credential <name>`, `tool <name>`, or `approval` when the client cannot ask a person) |
| `CredentialUnavailable` | A credential is not set in the environment |
| `SettingUnavailable` | A setting is not set in the environment; reported through `PreflightFailed` as `setting <name>` |
| `AuthorizationFailed` | `stepgate --auth` could not authorize a credential, or an MCP server's authorization metadata could not be read |
| `InvalidGrant` | An OAuth grant was revoked; never retried |
| `EgressDenied` | A request targeted a host no tool declares |
| `ToolCallFailed` | A call still failed after retries, or a POST failed once; carries the status code and body |
| `ResponseTooLarge` | A response was larger than `--response-bytes` |
| `PlaceholderUnresolved` | A placeholder had no value when the step started |
| `GateFailed` | A step used up its retries; names the step and the failing gates |
| `CallArgumentsInvalid` | A mechanical step computed arguments its operation's schema refuses; names the step and call |
| `CallLimitReached` | A step hit the tool-call limit |
| `RunNotActive` | A call named a run that finished, failed, was abandoned or never existed |
| `DraftRefused` | A draft given to `stepgate_try` declares a credential or setting the operator did not grant, lists a host its credential was not granted for, or calls a URL that is not public `https` |
| `UrlNotPublic` | `stepgate_inspect_api` was given a URL that is not public `https` |
| `ApiDocumentInvalid` | An inspected OpenAPI document does not parse, or has a `$ref` Stepgate cannot inline |

<p align="right">(<a href="#top">back to top</a>)</p>

## The ledger

Every run writes a hash-chained ledger.

Each record carries `run`, `stepfile`, `seq`, `type`, `at` (an RFC 3339 time) and `prev`. `prev` is the SHA-256 of the previous record's RFC 8785 canonical form, so editing any record breaks the chain.

Records are stored exactly as they were hashed:

- with `--ledger-dir`, as one `<stepfile>-<run>.jsonl` file per run;
- otherwise, as JSON lines on standard error.

`stepgate --verify <file>...` checks each file, and exits 1 naming the first `seq` that does not follow.

| Record | Carries |
|---|---|
| `run_started` | the stepfile's identity and a hash of the inputs |
| `step_started`, `step_skipped`, `step_passed` | the step and attempt |
| `tool_call` | tool, operation, host, status, duration, the credential's name, a hash and length of the response, and the length the client was shown after any `select`; `caller`, which is `client` or `stepgate`, and for a mechanical step's call its `call` id |
| `computed` | a mechanical step's output, as a hash and length |
| `tool_refused` | an operation the step does not allow, which the client tried to call |
| `submit` | the step, attempt, and a hash and length of the output |
| `derived` | the step, attempt, and a hash and length of the output once its `derive` fields are added |
| `gate` | the gate, its verdict and a hash of its diagnosis; an output that breaks `produces` is a failed gate named `produces` |
| `retry` | the operation, attempt, status and how long it waited |
| `run_finished`, `run_failed`, `run_abandoned` | the outcome, the error type, or that the client stopped calling |

Request bodies, responses and outputs appear only as hashes and lengths.

No credential value, and no hash of one, is ever recorded, because a hash of a short secret can be cracked.

<p align="right">(<a href="#top">back to top</a>)</p>

## Design choices

- **The file names no model, provider or framework.** An optional model hint would become the norm, and the file would then only work where that model exists.
- **Remote tools only.** Running local code would need provisioning and a sandbox, and no portable sandbox exists.
- **The client's agent does the steps.** Any MCP client with a tool-calling model can run a stepfile, with no model key in Stepgate. MCP sampling, where the server borrows the client's model, is deprecated as of protocol 2026-07-28. Claude Code and claude.ai do not support it.
- **Steps end with a typed submission.** Gates get structured data instead of prose to parse.
- **Gates are mechanical and always block.** A model grading a model's work is what Stepgate exists to avoid. A check that doesn't block is one nobody notices has stopped working.
- **Failed gates explain themselves.** The diagnosis goes back to the model for a bounded number of retries, instead of stopping at the first failure.
- **Linear steps.** Branching, loops and parallel blocks would each add control-flow grammar. `when` covers optional steps.
- **Later steps stay hidden.** Showing only the current step is what stops skipping. The client keeps its own conversation, so earlier steps are not hidden from it.
- **Stepgate makes every tool call.** Credentials, the host allowlist and the evidence gates see all depend on it. The stepfile's operations are therefore reachable only through `stepgate_call`.
- **Triggers stay with the client.** A shared file that could schedule itself would run on someone's machine unasked.
- **An MCP server, not a library.** Clients already speak MCP, so connecting costs one line of configuration rather than a dependency to install and upgrade. It also means a stepfile cannot choose which Stepgate version runs it, so it cannot downgrade to one without a fix.

<p align="right">(<a href="#top">back to top</a>)</p>
