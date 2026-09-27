# Connecting a client

Stepgate is an MCP server, so any MCP client whose model can call tools can run stepfiles: Claude Code, Claude Desktop, Cursor, VS Code, or an agent you wrote yourself. The client's own model does each step; Stepgate needs no model key.

You need Node.js 22.18 or later where the client runs.

## What the server command looks like

Every client launches the same command:

```sh
npx -y stepgate market-research drug-shortage-watch
```

Each argument is the name of a stepfile in the [catalog](../stepfiles/) or a path to your own `.stepfile.yaml`. `npx -y stepgate --list` shows the catalog. Useful options:

- `--ledger-dir <dir>` writes one ledger file per run; without it, ledger records go to standard error, which most clients hide.
- `--contact <email>` adds your email to the User-Agent, which SEC EDGAR and USAJOBS require.
- `--tool-result-chars <n>` raises the 20,000-character cap on each result passed to the model.

Credentials and settings come from the server's environment. A stepfile's README lists what it needs: credential `tavily` is read from `TAVILY_API_KEY`, and setting `jira-site` from `JIRA_SITE`. Set them in the client's server configuration, as below. The model never sees them.

## Your own stepfiles

A stepfile does not need to be in the catalog to run. Pass its path, alone or next to catalog names:

```sh
npx -y stepgate /Users/me/flows/invoice-check.stepfile.yaml market-research
```

- **Use an absolute path.** A relative path is resolved from the folder the client starts the server in. Claude Code starts it in the project folder; other clients do not say.
- **Each file becomes one tool named after its `id`,** so every file you serve needs its own `id`.
- **Mistakes show when the server starts.** Every file is validated at startup, and a broken one stops the server with the reason, such as `StepfileInvalid: stepfile invalid: /stepgate must be equal to constant`. The client shows this as a server that failed to start; Claude Code's `/mcp` and Claude Desktop's logs carry the message.
- **Restart after editing.** Files are read once, at startup. In Claude Code, reconnect the server from `/mcp`.
- **Credentials and settings work as for catalog entries:** credential `my-api` is read from `MY_API_API_KEY` and setting `erp-host` from `ERP_HOST`. An `oauth2` credential with a `token_url` can take `MY_API_REFRESH_TOKEN` and `MY_API_CLIENT_ID` instead, and Stepgate refreshes the access token itself ([stepfile.md](stepfile.md#credentials)).
- **Your own files may call `http://localhost`,** which helps while testing against a local API. Catalog entries must use public `https` URLs.

To have your editor check the file as you type, start it with this line; editors using `yaml-language-server`, such as VS Code with the YAML extension, then validate every field:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Chaarangan/stepgate/main/server/schema/stepfile.schema.json
```

## Writing stepfiles with an agent

Every Stepgate server also offers tools for writing new stepfiles, so you can ask your agent for one in plain words:

> Write a stepfile that converts an amount between currencies at the latest ECB rate, using the Frankfurter API. Try it with 250 USD to EUR.

| Tool | What the agent gets |
|---|---|
| `stepgate_guide` | The authoring workflow, the full format reference and the JSON Schema |
| `stepgate_examples` | The catalog as a list, or one entry's stepfile and README to copy a pattern from |
| `stepgate_inspect_api` | For an OpenAPI document: its sha256 to pin, servers, security schemes, operationIds, and each operation's arguments and success response. Operations without an operationId are listed with their definitions to copy inline. For an MCP server: its tools and their `schema_sha256` |
| `stepgate_validate` | Every issue in a draft with its path, or the draft's identity and whether it can be tried |
| `stepgate_try` | A run of the draft from its text, driven with `stepgate_call` and `stepgate_submit` like any run |

`npx -y stepgate` with no stepfiles starts a server that offers only these tools.

Drafts are written by a model, so `stepgate_try` holds them to stricter rules than files you load yourself. Its tools must use public `https` URLs. A draft may declare only the credentials and settings you grant to drafts, because Stepgate would otherwise read their values from your environment and send them wherever the draft's author chose:

```
npx -y stepgate --draft-credential jira=acme.atlassian.net --draft-setting jira-site
```

A granted credential is refused if the draft lists any host you did not name, or a `token_url`, so a draft can only send it where you said. Inspection sends no credentials, and only to public `https` URLs. Any other stepfile that needs a key is tried by saving it and adding its path to the server's configuration, as in [your own stepfiles](#your-own-stepfiles).

"Public" is decided from the URL's host name: loopback, private and link-local addresses and names without a dot are refused, but a public name that resolves to a private address is not caught. Run Stepgate where reaching any public host is acceptable.

## Claude Code

Add the server from your project folder:

```sh
claude mcp add stepgate -e TAVILY_API_KEY=tvly-... -- npx -y stepgate market-research
```

`-s project` writes it to `.mcp.json` in the project root so your team shares it, and `-s user` makes it available in every project. A shared `.mcp.json` should reference keys rather than contain them, because Claude Code expands `${VAR}` from your environment:

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "--ledger-dir", ".stepgate/ledgers", "market-research"],
      "env": { "TAVILY_API_KEY": "${TAVILY_API_KEY}" }
    }
  }
}
```

Start `claude` in that folder. It asks once whether to trust servers from `.mcp.json`. Then ask for a run in plain words:

> Run the market-research stepfile for brand Oatly in the UK plant-based milk market.

Claude calls `market-research`, works through each step with `stepgate_call` and `stepgate_submit`, fixes whatever the gates reject, and reports the outputs. Claude Code asks before each tool call until you allow them; to allow every Stepgate tool, add `"mcp__stepgate__*"` to `permissions.allow` in `.claude/settings.json`. `/mcp` shows whether the server connected.

To run without the interactive session, pass the configuration explicitly:

```sh
claude -p --mcp-config .mcp.json --allowedTools "mcp__stepgate__*" \
  "Run the market-research stepfile for brand Oatly in the UK plant-based milk market."
```

## Claude Desktop

Open **Settings > Developer > Edit Config**, which opens `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows), and add:

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

Quit and reopen Claude Desktop. If the server fails to start, Desktop may not have found `npx` on its `PATH`; replace `"npx"` with the output of `which npx`. Server logs are in `~/Library/Logs/Claude/` on macOS.

## Cursor

Add the same `mcpServers` block to `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project. Cursor reads a variable from your shell with `"TAVILY_API_KEY": "${env:TAVILY_API_KEY}"`.

## VS Code

VS Code uses a `servers` key and a `type` field, in `.vscode/mcp.json`. An `inputs` entry asks for the key once and stores it:

```json
{
  "inputs": [{ "type": "promptString", "id": "tavily-key", "description": "Tavily API key", "password": true }],
  "servers": {
    "stepgate": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "stepgate", "market-research"],
      "env": { "TAVILY_API_KEY": "${input:tavily-key}" }
    }
  }
}
```

## Clients that connect by URL

Run the server yourself and point the client at it:

```sh
TAVILY_API_KEY=tvly-... npx -y stepgate --http 3100 market-research
```

The endpoint is `http://127.0.0.1:3100/mcp`, using Streamable HTTP. It listens on the loopback address only. claude.ai connectors need a public HTTPS URL, which Stepgate does not provide.

## Your own agent

Your agent needs an MCP client and a model that calls tools. List Stepgate's tools, pass them to your model with the server's instructions (`getInstructions()` in the TypeScript SDK) as part of the system prompt, and forward each tool call to Stepgate until a response's `structuredContent.state` is `finished` or `failed`. [server/examples/demo-client.ts](../server/examples/demo-client.ts) does this in about a hundred lines with any OpenAI-compatible API.

## What a run looks like

1. The agent calls the stepfile's tool with its inputs. Stepgate checks every credential and API first, then returns a run id and step 1: instructions, the operations it may call, and the output schema.
2. The agent calls those operations through `stepgate_call`. Stepgate makes each request, adds credentials, and returns the result.
3. The agent sends the step's output to `stepgate_submit`. If a gate rejects it, the response says which gate and why, and how many attempts are left. When every gate passes, the response is the next step.
4. After the last step, the response holds every step's output.

Every response carries its content both as text and as `structuredContent`, because some clients, Claude Code among them, show the model only the structured part.

## When something goes wrong

| What you see | What it means |
|---|---|
| `PreflightFailed: preflight failed for credential tavily` | `TAVILY_API_KEY` is not set in the server's environment. Set it in the client's configuration and restart the server. |
| `PreflightFailed: ... setting jira-site` | A setting is missing, or its value does not match the setting's pattern. |
| `GateFailed: step ... failed gates: ...` | The step used every attempt without passing; the gates named are the ones that failed last. |
| `RunNotActive` | The run finished, failed, or sat idle past `--run-idle-ms` (30 minutes by default). Start it again. |
| `CallLimitReached` | One step made more than `--calls-per-step` calls (100 by default), which usually means the agent was looping. |
| The agent stops partway through | Ask it to continue the run; the run waits for its next call until it goes idle. |
| A result ends in `[truncated: ...]` | Raise `--tool-result-chars`. Claude Code also caps each tool result at 25,000 tokens unless `MAX_MCP_OUTPUT_TOKENS` is set higher. |
