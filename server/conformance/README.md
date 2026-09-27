# Conformance cases

Each `*.case.yaml` here is a run any Stepgate runtime must reproduce: a stepfile, its inputs, the fixture API or MCP server it calls, the actions a client takes, and what the client, the ledger and the fixture must see. `test/conformance.test.ts` runs them against this server, and the npm package ships them for other runtimes.

| Field | Meaning |
|---|---|
| `name` | What the case shows |
| `stepfile` | The stepfile, inline |
| `inputs` | The inputs the client starts the run with |
| `api` | Optional HTTP API: `routes`, each a `method`, a `path` (with query), optional `key` (`header`, `value`) or `bearer` it requires, and `answers` given in order, the last repeating; `{origin}`, `{host}` and `{port}` in an answer header are the API's own |
| `mcp` | Optional Streamable HTTP MCP server behind bearer `token`, offering `tools`, each a `name`, `description`, `inputSchema` and the `text` it answers |
| `credentials` | Credential values by name |
| `actions` | In order, each `{ submit: <output> }` or `{ call: <operation>, arguments: {...} }` |
| `expect.replies` | One per reply, starting with the one that starts the run: its `state` (`running`, `finished` or `failed`), and where they apply the current `step`, the failing gate ids as `failures`, the `error` type, whether it `is_error`, and text the reply must `contain` |
| `expect.ledger` | Every record's `type`, in order |
| `expect.requests` | Every request the `api` received, in order, as `method`, `path` and the `headers` it must carry |

`${api.origin}`, `${api.host}`, `${mcp.origin}` and `${mcp.host}` in a stepfile are replaced with the fixtures' addresses before it loads.
