# drug-shortage-watch

Checks every generic drug on a hospital formulary against the FDA drug shortage list, served by openFDA, and returns an action list for a pharmacy buyer. Shortage status changes weekly, so a model answering from memory gets it wrong. Here Stepgate makes the openFDA searches and builds the action list itself, so no status, count, date or NDC can be misread or invented, and the agent only writes the summary, whose gates check it against those records.

## Steps

1. **status** (mechanical): Stepgate asks openFDA for the count of shortage records per status (Current, To Be Discontinued, Resolved) for each formulary item, with a `generic_name` search naming it, and sets its worst status: Current if listed, else To Be Discontinued, else Resolved, or null when openFDA answers 404 `NOT_FOUND`. It keeps openFDA's `last_updated` date.
2. **records** (mechanical): for each item with shortage records, Stepgate fetches up to three records at its worst status and keeps the total and each record's package NDC, generic name, company, status and update date. A gate stops the run if a record does not have the status searched for.
3. **report**: the agent writes a Markdown summary. Stepgate derives one action per formulary item, its worst status (or `Not listed`) with the NDCs of its records. Gates check that the summary bolds exactly the items in Current or To Be Discontinued shortage, and that every NDC it mentions came from step 2.

## Inputs

| Input | Meaning |
|---|---|
| `formulary` | Generic drug names to check, 1 to 20, for example `["lidocaine", "methotrexate"]`. Matching is on openFDA's `generic_name` field. |

## Credentials

None needed. openFDA answers without a key, within 240 requests a minute and 1,000 a day per IP address. A run makes at most two requests per formulary item.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "drug-shortage-watch"]
    }
  }
}
```

Then call the `drug-shortage-watch` tool with `{ "formulary": ["lidocaine", "methotrexate", "sodium chloride", "albuterol", "amoxicillin"] }`. On 26 September 2026 that formulary returned lidocaine and methotrexate in Current shortage, sodium chloride To Be Discontinued, albuterol Resolved and amoxicillin not listed. The action list is in `outputs.report.actions` and the summary in `outputs.report.summary_markdown`.

Each shortage record from openFDA is about 3,500 characters, so step 2 asks for three per item to stay well inside a model's context.
