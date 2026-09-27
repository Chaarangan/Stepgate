# Conformance cases

Each `*.case.yaml` here is a keyless run any Stepgate runtime must reproduce: a stepfile, its inputs, the actions a client takes, and what the client and the ledger must see. `test/conformance.test.ts` runs them against this server, and the npm package ships them for other runtimes.

| Field | Meaning |
|---|---|
| `name` | What the case shows |
| `stepfile` | The stepfile, inline |
| `inputs` | The inputs the client starts the run with |
| `actions` | In order, each `{ submit: <output> }` |
| `expect.replies` | One per reply, starting with the one that starts the run: its `state` (`running`, `finished` or `failed`), and where they apply the current `step`, the failing gate ids as `failures`, the `error` type, and text the reply must `contain` |
| `expect.ledger` | Every record's `type`, in order |

TODO(conformance-tools): cases for operations, egress, credentials and retries need API and MCP fixtures a second runtime can run too.
