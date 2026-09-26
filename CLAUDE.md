# Stepgate

A stepfile format (`docs/stepfile.md`, `server/schema/`) and Stepgate, the MCP server in `server/` that runs stepfiles (`docs/how-it-works.md`).

## Commands

Run everything from `server/`:

- `npm run check`: type checker and all tests. Run it before calling a change done.
- `npm run build`: compile to `dist/`.

## Where things are

- `server/src/engine/`: load and validate, the step loop (`run.ts`), OpenAPI and MCP tools, gates, ledger.
- `server/src/server.ts`: stepfiles as MCP tools; the model is reached through sampling.
- `server/test/harness.ts`: starts fixture servers and a scripted-sampling client. New tests use it.

## Rules

- Use the vocabulary in `CONTEXT.md` (stepfile, step, gate, Stepgate, client, ledger).
- A format change updates `docs/stepfile.md`, the schema and the code together.
- Tests go through the MCP server with the harness; the scripted model is the only fake.
