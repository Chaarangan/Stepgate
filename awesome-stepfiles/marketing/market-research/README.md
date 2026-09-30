# market-research

Researches a brand's position in a market from web sources and writes a short report in which every claim cites a source. Irrelevant sources are discarded on the record, with a reason, before any claim is made.

## Steps

Every step is an agent step; the searches and the relevance decisions are judgement.

1. **search**: runs at least six web searches and records every result as a numbered source. Stepgate derives `query_count` from the distinct queries of the successful searches. Gates check there are at least 12 sources, from at least six domains, with unique ids, and that six distinct queries ran.
2. **filter**: decides keep or discard for every source, with a reason. Stepgate derives `kept`, the number kept. Gates check every source is decided exactly once and at least five are kept.
3. **analyse**: writes one-sentence claims, each citing kept sources. A gate checks every citation points at a kept source.
4. **report**: writes a Markdown report with fixed sections. Gates check the sections are in order, the report is not padded, and it cites at least one source and only sources an analysed claim uses.

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
