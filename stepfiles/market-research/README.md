# market-research

Researches a brand's position in a market from web sources and writes a short report in which every claim cites a source. Irrelevant sources are discarded on the record, with a reason, before any claim is made.

## Steps

1. **search**: runs at least six web searches and records every result as a numbered source. Gates check there are at least 12 sources, from at least six domains, with unique ids.
2. **filter**: decides keep or discard for every source, with a reason. Gates check every source is decided exactly once and at least five are kept.
3. **analyse**: writes one-sentence claims, each citing kept sources. A gate checks every citation points at a kept source.
4. **report**: writes a Markdown report with fixed sections. Gates check the sections are in order, the report is not padded, and every inline citation resolves to an analysed claim.

## Inputs

| Input | Meaning |
|---|---|
| `brand` | The brand to research, for example `Oatly` |
| `market` | The market to research it in, for example `UK plant-based milk` |

## Credentials

| Variable | What for |
|---|---|
| `TAVILY_API_KEY` | Web search through Tavily's remote MCP server. Get a key at [tavily.com](https://tavily.com). |

## Run it

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

Then call the `market-research` tool with `{ "brand": "Oatly", "market": "UK plant-based milk" }`. The result holds every step's output; the report is in `outputs.report.report`.

Each search asks for three results so six searches fit comfortably in a model's context. A run makes one model turn per step when the model gets it right first time, plus one for the searches.
