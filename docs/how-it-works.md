# How Stepgate works

Stepgate is an MCP server. It offers each stepfile it loads as a tool, and when a client calls that tool it runs the stepfile's steps on the client's own model, reached through MCP sampling. For the file format itself, see [stepfile.md](stepfile.md).

## One turn at a time

The model never holds the stepfile. Stepgate reads it and asks the model for one turn at a time, with only the current step's instructions and tools:

```
stepgate preflights every credential and tool
stepgate → model   step 1 instructions, step 1 tools, submit
model → stepgate   tool calls (run by stepgate), then submit(output)
stepgate checks step 1 gates                → fail: diagnosis back to model
model → stepgate   submit(corrected output)
stepgate checks step 1 gates                → pass
stepgate → model   fresh context, step 2 instructions only
```

The model cannot skip step 2, because it is not told step 2 exists until it is asked to do it. It cannot declare step 1 done, because a step passes only when its gates pass over the output it submitted. It cannot reach an undeclared host or read a key, because Stepgate makes every tool call.

What this guarantees is that the path through a stepfile depends only on submitted outputs and mechanical checks. The outputs themselves still come from a model and still vary.

## Connecting a client

`stepgate <file>...` serves over stdio, which is how desktop MCP clients launch servers. `--http <port>` serves Streamable HTTP at `/mcp` instead. Every file is loaded and validated at start, so an invalid stepfile stops the server rather than failing a call.

- **Listing.** Each stepfile is one tool: `id` is its name, `description` its description, and `inputs` its input schema.
- **Calling.** The call's arguments are the run's inputs. The calling agent supplies inputs only; it cannot add or change credentials.
- **Sampling.** The client must declare the `sampling.tools` capability. A call from a client without it gets a tool error before anything is contacted. Over HTTP, sampling requests travel on the stream of the tool call that caused them, so HTTP sessions are stateful.
- **Progress.** If the call carries a `progressToken`, each ledger record is also sent as a progress notification, which lets a client keep a long run alive with progress-reset timeouts.
- **Result.** `structuredContent` is `{ identity, outputs }`, holding every step's accepted output. A failed run returns a tool error whose text starts with the error type.

The MCP spec suggests clients let a person approve each sampling request. A stepfile makes many, so clients that call their model from code suit Stepgate better than desktop apps that prompt every time.

## During a run

**Preflight.** Before step 1, Stepgate validates the inputs, checks that every declared credential is set, fetches each OpenAPI document and checks its digest and exposed operations, and connects to each MCP server to check its exposed tools and pinned schemas. Any failure stops the run with `PreflightFailed` naming what failed, before the model is asked anything.

**Isolation.** Every step starts a fresh conversation holding only its own instructions, with placeholders filled in. The model never sees the stepfile, the list of steps, or another step's instructions.

**Tool calls.** Stepgate makes every call itself. It checks the model's arguments against the tool's schema first and returns any mismatch to the model as an error. It refuses any request to a host no tool declares (`EgressDenied`); the one exception is fetching an OpenAPI document from its declared `url` during preflight, which carries no credential. Path parameters are percent-encoded, so no argument can change the host. Tool results reach the model as data.

**Credentials.** Credential `<name>` is read from `<NAME>_API_KEY` in Stepgate's environment, which an MCP client sets in its server configuration. A value is read when a request needs it and kept no longer than that request.

**Retries.** Calls to tools, verifiers and OpenAPI documents are retried on network errors, 429 and 5xx, each retry leaving a `retry` record, and then the last error is raised. An OAuth `invalid_grant` stops the run at once with `InvalidGrant`, because a revoked grant will not recover and retrying can revoke a working one.

## Limits

Limits depend on the model's context, so they are command-line options rather than stepfile fields:

| Option | Default | Meaning |
|---|---|---|
| `--turns-per-step` | 30 | Most model turns one step may take, across all attempts (`TurnLimitReached`) |
| `--tool-result-chars` | 20000 | Longest tool result passed to the model; longer results are cut and end with a visible `[truncated: …]` note |
| `--max-tokens` | 16000 | `maxTokens` on each sampling request |
| `--sampling-timeout-ms` | 600000 | How long one sampling request may take |
| `--ledger-dir` | none | Write one ledger file per call here; otherwise records go to standard error |

## Errors

| Error | Meaning |
|---|---|
| `StepfileInvalid` | The file failed the schema or a load-time rule; carries each issue's path |
| `PreflightFailed` | A check before step 1 failed; names the `item` (`inputs`, `credential <name>` or `tool <name>`) |
| `CredentialUnavailable` | A credential is not set in the environment |
| `InvalidGrant` | An OAuth grant was revoked; never retried |
| `EgressDenied` | A request targeted a host no tool declares |
| `ToolCallFailed` | A call still failed after retries; carries the status code and body |
| `PlaceholderUnresolved` | A placeholder had no value when the step started |
| `GateFailed` | A step used up its retries; names the step and the failing gates |
| `TurnLimitReached` | A step hit the turn limit |
| `ModelTurnFailed` | The client's sampling request failed |

## The ledger

Every run writes a hash-chained ledger. Each record carries `seq`, `type`, `at` (an RFC 3339 time) and `prev`, the hash of the previous record, so editing any record breaks the chain.

| Record | Carries |
|---|---|
| `run_started` | the stepfile's identity and a hash of the inputs |
| `step_started`, `step_skipped`, `step_passed` | the step and attempt |
| `tool_call` | tool, operation, host, status, duration, and the credential's name |
| `tool_refused` | a tool the step does not allow, which the model tried to call |
| `submit` | the step, attempt, and a hash and length of the output |
| `gate` | the gate, its verdict and a hash of its diagnosis; a turn with no `submit` is a failed gate named `submit` |
| `retry` | the operation, attempt and status |
| `run_finished`, `run_failed` | the outcome or error type |

Request bodies, responses and outputs appear only as hashes and lengths. No credential value, and no hash of one, is ever recorded, because a hash of a short secret can be cracked.

## Design choices

- **The file names no model, provider or framework.** An optional model hint would become the norm, and the file would then only work where that model exists.
- **Remote tools only.** Running local code would need provisioning and a sandbox, and no portable sandbox exists.
- **Steps end with a typed `submit`.** It works on any model that can call tools, and gates get structured data instead of prose to parse.
- **Gates are mechanical and always block.** A model grading a model's work is what Stepgate exists to avoid, and a check that doesn't block is one nobody notices has stopped working.
- **Failed gates explain themselves.** The diagnosis goes back to the model for a bounded number of retries instead of stopping at the first failure.
- **Linear steps.** Branching, loops and parallel blocks would each add control-flow grammar; `when` covers optional steps.
- **Fresh context per step.** A step that inherits the previous step's reasoning inherits its blind spots, and hiding later steps is what stops skipping.
- **Stepgate makes every tool call.** Prompt injection through an API response is the main remaining risk, so tool use is never left to the model.
- **Triggers stay with the client.** A shared file that could schedule itself would run on someone's machine unasked.
- **An MCP server, not a library.** Clients already speak MCP, so connecting costs one line of configuration rather than a dependency to install and upgrade. It also means a stepfile cannot choose which Stepgate version runs it, so it cannot downgrade to one without a fix.
