<a id="top"></a>

<p><a href="../README.md">Stepgate</a> &middot; <a href="stepfile.md">Writing a stepfile</a> &middot; <strong>Connecting a client</strong> &middot; <a href="how-it-works.md">How it works</a></p>

# Connecting a client

Stepgate is an MCP server, so any MCP client whose model can call tools can run stepfiles: Claude Code, Claude Desktop, Cursor, VS Code, or an agent you wrote yourself. The client's own model does each step; Stepgate needs no model key.

You need Node.js 22.18 or later where the client runs.

<details>
  <summary>Contents</summary>
  <ol>
    <li><a href="#what-the-server-command-looks-like">What the server command looks like</a></li>
    <li>
      <a href="#claude-code">Claude Code</a>
      <ul>
        <li><a href="#approvals">Approvals</a></li>
      </ul>
    </li>
    <li><a href="#claude-desktop">Claude Desktop</a></li>
    <li><a href="#cursor">Cursor</a></li>
    <li><a href="#vs-code">VS Code</a></li>
    <li><a href="#clients-that-connect-by-url">Clients that connect by URL</a></li>
    <li><a href="#your-own-agent">Your own agent</a></li>
    <li><a href="#what-a-run-looks-like">What a run looks like</a></li>
    <li><a href="#when-something-goes-wrong">When something goes wrong</a></li>
    <li>
      <a href="#your-own-stepfiles">Your own stepfiles</a>
      <ul>
        <li><a href="#paths-and-ids">Paths and ids</a></li>
        <li><a href="#mistakes-and-edits">Mistakes and edits</a></li>
        <li><a href="#credentials-and-hosts">Credentials and hosts</a></li>
        <li><a href="#editor-checking">Editor checking</a></li>
      </ul>
    </li>
    <li><a href="#mcp-servers-that-use-mcp-authorization">MCP servers that use MCP authorization</a></li>
    <li>
      <a href="#writing-stepfiles-with-an-agent">Writing stepfiles with an agent</a>
      <ul>
        <li><a href="#inspecting-an-api">Inspecting an API</a></li>
        <li><a href="#outlining-a-procedure">Outlining a procedure</a></li>
        <li><a href="#what-drafts-may-do">What drafts may do</a></li>
      </ul>
    </li>
  </ol>
</details>

## What the server command looks like

Every client launches the same command:

```sh
npx -y stepgate market-research drug-shortage-watch
```

Each argument is the name of a stepfile in the [catalog](../awesome-stepfiles/) or a path to your own `.stepfile.yaml`. `npx -y stepgate --list` shows the catalog.

Options you are likely to want:

- **`--ledger-dir <dir>`** writes one ledger file per run. Without it, ledger records go to standard error, which most clients hide.
- **`--contact <email>`** adds your email to the User-Agent. SEC EDGAR and USAJOBS require it.
- **`--tool-result-chars <n>`** raises the 20,000-character cap on each result passed to the model.

[how-it-works.md](how-it-works.md#limits) lists every option.

Credentials and settings come from the server's environment, and the model never sees them. A stepfile's README lists what it needs:

- credential `tavily` is read from `TAVILY_API_KEY`;
- setting `jira-site` is read from `JIRA_SITE`.

Set them in the client's server configuration, as the sections below show.

<p align="right">(<a href="#top">back to top</a>)</p>

## Claude Code

Add the server from your project folder:

```sh
claude mcp add stepgate -e TAVILY_API_KEY=tvly-... -- npx -y stepgate market-research
```

Choose where the configuration lives:

- **`-s project`** writes it to `.mcp.json` in the project root, so your team shares it.
- **`-s user`** makes it available in every project.

A shared `.mcp.json` should reference keys rather than contain them. Claude Code expands `${VAR}` from your environment:

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

Claude calls `market-research` and works through each step with `stepgate_call` and `stepgate_submit`. It fixes whatever the gates reject, then reports the outputs.

- **Permissions.** Claude Code asks before each tool call until you allow them. To allow every Stepgate tool, add `"mcp__stepgate__*"` to `permissions.allow` in `.claude/settings.json`.
- **Connection.** `/mcp` shows whether the server connected.

To run without the interactive session, pass the configuration explicitly:

```sh
claude -p --mcp-config .mcp.json --allowedTools "mcp__stepgate__*" \
  "Run the market-research stepfile for brand Oatly in the UK plant-based milk market."
```

### Approvals

A stepfile with an `approve` gate asks you through a form the client shows. As of 2026-09-28, only Claude Code in a terminal (`claude`) shows it.

These tell Stepgate they can show the form, then decline every request without asking you ([#79174](https://github.com/anthropics/claude-code/issues/79174), [#89858](https://github.com/anthropics/claude-code/issues/89858)):

- the VS Code extension;
- the desktop app;
- `claude -p`;
- the Agent SDK without an `onElicitation` handler.

The run then fails that gate, whatever you would have answered. Run a stepfile that writes from the terminal.

<p align="right">(<a href="#top">back to top</a>)</p>

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

Quit and reopen Claude Desktop.

If the server fails to start, Desktop may not have found `npx` on its `PATH`. Replace `"npx"` with the output of `which npx`. Server logs are in `~/Library/Logs/Claude/` on macOS.

<p align="right">(<a href="#top">back to top</a>)</p>

## Cursor

Add the same `mcpServers` block to `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project. Cursor reads a variable from your shell with `"TAVILY_API_KEY": "${env:TAVILY_API_KEY}"`.

<p align="right">(<a href="#top">back to top</a>)</p>

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

<p align="right">(<a href="#top">back to top</a>)</p>

## Clients that connect by URL

Run the server yourself and point the client at it:

```sh
TAVILY_API_KEY=tvly-... npx -y stepgate --http 3100 market-research
```

The endpoint is `http://127.0.0.1:3100/mcp`, using Streamable HTTP. It listens on the loopback address only. claude.ai connectors need a public HTTPS URL, which Stepgate does not provide.

<p align="right">(<a href="#top">back to top</a>)</p>

## Your own agent

Your agent needs an MCP client and a model that calls tools. Then:

1. List Stepgate's tools.
2. Pass them to your model, with the server's instructions (`getInstructions()` in the TypeScript SDK) as part of the system prompt.
3. Forward each tool call to Stepgate until a response's `structuredContent.state` is `finished` or `failed`.

[server/examples/demo-client.ts](../server/examples/demo-client.ts) does this in about a hundred lines with any OpenAI-compatible API.

<p align="right">(<a href="#top">back to top</a>)</p>

## What a run looks like

1. **The agent starts the run.** It calls the stepfile's tool with its inputs. Stepgate checks every credential and API first, then returns a run id and step 1: instructions, the operations it may call, and the output schema.
2. **The agent calls operations.** It calls them through `stepgate_call`. Stepgate makes each request, adds credentials, and returns the result.
3. **The agent submits.** It sends the step's output to `stepgate_submit`.
   - If a gate rejects it, the response says which gate and why, and how many attempts are left.
   - When every gate passes, the response is the next step.
4. **The run finishes.** After the last step, the response holds every step's output.

Every response carries its content both as text and as `structuredContent`, because some clients, Claude Code among them, show the model only the structured part.

<p align="right">(<a href="#top">back to top</a>)</p>

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

<p align="right">(<a href="#top">back to top</a>)</p>

## Your own stepfiles

A stepfile does not need to be in the catalog to run. Pass its path, alone or next to catalog names:

```sh
npx -y stepgate /Users/me/flows/invoice-check.stepfile.yaml market-research
```

### Paths and ids

- **Use an absolute path.** A relative path is resolved from the folder the client starts the server in. Claude Code starts it in the project folder; other clients do not say.
- **Each file becomes one tool named after its `id`,** so every file you serve needs its own `id`.

### Mistakes and edits

- **Mistakes show when the server starts.** Every file is validated at startup, and a broken one stops the server with the reason, such as `StepfileInvalid: stepfile invalid: /stepgate must be equal to constant`.
- **The client shows this as a server that failed to start.** Claude Code's `/mcp` and Claude Desktop's logs carry the message.
- **Without `--watch`, restart after editing.** Files are read once, at startup. In Claude Code, reconnect the server from `/mcp`.
- **With `--watch`, Stepgate reloads a file when it changes** and tells the client its tools changed. A run in progress finishes on the version it started with.
- **A file that breaks under `--watch` stays listed under its old name.** That covers a file that no longer loads, has been removed, or takes an id another served file has. Calling it reports why, rather than running the old version.

### Credentials and hosts

- **Credentials and settings work as for catalog entries.** Credential `my-api` is read from `MY_API_API_KEY`, and setting `erp-host` from `ERP_HOST`.
- **An `oauth2` credential with a `token_url` can take a refresh token instead:** `MY_API_REFRESH_TOKEN` and `MY_API_CLIENT_ID`. Stepgate refreshes the access token itself ([stepfile.md](stepfile.md#credentials)).
- **Your own files may call `http://localhost`,** which helps while testing against a local API. Catalog entries must use public `https` URLs.

### Editor checking

To have your editor check the file as you type, start it with this line. Editors using `yaml-language-server`, such as VS Code with the YAML extension, then validate every field:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Chaarangan/stepgate/main/server/schema/stepfile.schema.json
```

<p align="right">(<a href="#top">back to top</a>)</p>

## MCP servers that use MCP authorization

Some remote MCP servers, such as Linear's and Notion's, issue tokens through their own OAuth authorization server rather than taking an API key. A stepfile declares such a credential as `oauth2` with the advertised `token_url`.

You authorize it once:

```sh
npx -y stepgate --auth <stepfile.yaml | catalog name> <credential>
```

1. Stepgate finds the server's authorization server, registers itself as a client, and prints a URL to open.
2. You approve access in the browser.
3. Stepgate prints the variables to set in the server's configuration: `<NAME>_REFRESH_TOKEN`, `<NAME>_CLIENT_ID` and `<NAME>_RESOURCE`. When the server issues no refresh token, it prints `<NAME>_API_KEY` instead.

It writes nothing to disk.

Where the authorization server offers no client registration, pass `--client-id` with a client you registered for `http://127.0.0.1` redirects.

<p align="right">(<a href="#top">back to top</a>)</p>

## Writing stepfiles with an agent

Every Stepgate server also offers tools for writing new stepfiles, so you can ask your agent for one in plain words:

> Write a stepfile that converts an amount between currencies at the latest ECB rate, using the Frankfurter API. Try it with 250 USD to EUR.

| Tool | What the agent gets |
|---|---|
| `stepgate_guide` | The authoring workflow, the full format reference and the JSON Schema |
| `stepgate_examples` | The catalog as a list, or one entry's stepfile and README to copy a pattern from |
| `stepgate_inspect_api` | What it needs to declare an API or MCP server ([details](#inspecting-an-api)) |
| `stepgate_outline` | A skeleton stepfile from a SKILL.md or markdown SOP ([details](#outlining-a-procedure)) |
| `stepgate_validate` | Every `TODO(...)` marker still to write, every issue in a draft with its path, or the draft's identity and whether it can be tried |
| `stepgate_try` | A run of the draft from its text, driven with `stepgate_call` and `stepgate_submit` like any run |

If you already have the procedure written down, as a skill or a runbook, start from it:

> Turn my release-notes SKILL.md into a stepfile with stepgate_outline, then fill in the gates and try it.

`npx -y stepgate` with no stepfiles starts a server that offers only these tools.

### Inspecting an API

`stepgate_inspect_api` returns, for an OpenAPI document:

- its sha256, to pin;
- its servers and security schemes;
- its operationIds, with each operation's arguments and success response;
- operations without an operationId, with their definitions to copy inline.

For an MCP server, it returns the server's tools and their `schema_sha256`.

### Outlining a procedure

`stepgate_outline` turns a SKILL.md or markdown SOP into a skeleton stepfile:

- **Steps.** One step per top-level numbered item where there are two or more; otherwise one per second-level heading. Code fences are ignored.
- **Gates.** Each rule the document states (MUST, SHALL, never) becomes a gate to write.
- **The rest.** Everything else is left as `TODO(...)` markers.

### What drafts may do

Drafts are written by a model, so `stepgate_try` holds them to stricter rules than files you load yourself.

- **Public URLs only.** A draft's tools must use public `https` URLs.
- **Granted credentials and settings only.** A draft may declare only the credentials and settings you grant to drafts. Otherwise Stepgate would read their values from your environment and send them wherever the draft's author chose.

```
npx -y stepgate --draft-credential jira=acme.atlassian.net --draft-setting jira-site
```

- **Granted credentials go only to the hosts you named.** A granted credential is refused if the draft lists any other host, or a `token_url`.
- **Inspection carries no credentials.** `stepgate_inspect_api` sends none, and reaches only public `https` URLs.
- **Anything else is tried from a file.** A stepfile that needs a key you have not granted is tried by saving it and adding its path to the server's configuration, as in [your own stepfiles](#your-own-stepfiles).

"Public" is decided from the URL's host name. Loopback, private and link-local addresses, and names without a dot, are refused. A public name that resolves to a private address is not caught, so run Stepgate where reaching any public host is acceptable.

<p align="right">(<a href="#top">back to top</a>)</p>
