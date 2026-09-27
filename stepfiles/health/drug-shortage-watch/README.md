# drug-shortage-watch

Checks every generic drug on a hospital formulary against the FDA drug shortage list, served by openFDA, and returns an action list for a pharmacy buyer. Shortage status changes weekly, so a model answering from memory gets it wrong; here every status, count, date and NDC in the result must match what openFDA returned during the run, and every formulary item must be accounted for, including the ones with no shortage record.

## Steps

1. **status**: asks openFDA for the count of shortage records per status (Current, To Be Discontinued, Resolved) for each formulary item. Gates check that every item was searched exactly once with a `generic_name` query naming it, that each set of counts is the exact response to that search, that an item reported with no records really got a `NOT_FOUND` answer, and that the data date is openFDA's own `last_updated`.
2. **records**: for each item with shortage records, fetches up to three records at its worst status. Gates check that exactly the items with records are covered, that the worst status follows from step 1's counts, that the search is scoped to that status, and that the total and every record (package NDC, generic name, company, status, update date) match a real response in order.
3. **report**: writes one action per formulary item and a Markdown summary. Gates check that every item has one action, that each status and NDC list matches the earlier steps (or is `Not listed` with no NDCs), that the summary bolds exactly the items in Current or To Be Discontinued shortage, and that every NDC it mentions came from step 2.

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
