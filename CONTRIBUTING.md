# Contributing

Thanks for helping. Bug reports, stepfiles that expose a gap in the format, and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with the stepfile that shows the problem, or a minimal one.
- **Format changes** (new fields, gate types or operators): open an issue first. A change to the format touches the specification, the schema and the server together, and is easier to agree before it is written.
- **Security issues:** follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setting up

You need Node.js 22.18 or later, which runs the TypeScript sources directly.

```sh
cd server
npm install
npm run check
```

`npm run check` runs the type checker and every test. It must pass before a pull request is merged, and CI runs it too.

To try a stepfile against a real model, run the demo client in `server/`. It launches Stepgate, answers its sampling requests with any OpenAI-compatible model, and runs the market-research example:

```sh
MODEL_BASE_URL=https://openrouter.ai/api/v1 MODEL_NAME=<model> MODEL_API_KEY=... TAVILY_API_KEY=... npm run demo
```

## Layout

| Path | What it is |
|---|---|
| `docs/stepfile.md`, `docs/how-it-works.md` | The stepfile format, and what Stepgate does with it |
| `server/schema/stepfile.schema.json` | The JSON Schema for stepfiles, shipped in the package |
| `server/src/engine/` | Loading, validation, the step loop, tools, gates and the ledger |
| `server/src/server.ts`, `server/src/cli.ts` | The MCP server and the `stepgate` command |
| `server/test/` | Tests, the shared harness, and local fixture servers |

## Making a change

- **Change the docs, the schema and the code in the same pull request** when the format changes. The server validates stepfiles against `server/schema/stepfile.schema.json` directly, and a test loads every file in `examples/`.
- **Test through the server.** Tests in `server/test/` call a stepfile as an MCP tool through the harness, against real local HTTP and MCP fixture servers. The scripted model is the only fake, because a real model is not deterministic. Add a test that fails without your change.
- **Keep stepfiles model-agnostic.** A field that only makes sense for one model, provider or framework does not belong in the format.

## Commits and pull requests

Commit subjects take the form `area: short lowercase summary`, where the area is one of `spec`, `schema`, `server`, `examples`, `docs`, `ci` or `chore`. Keep each commit to one change, and explain why in the body.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
