# disaster-declaration-brief

Writes a brief on the federal disaster declarations FEMA made for a US state over a date range, from the OpenFEMA FEMA Web Disaster Declarations dataset. Stepgate fetches the declarations and groups them by incident type and by the assistance programs they opened itself, so no number, date, type, flag or count can be misread; the agent writes the brief, and gates check its citations and counts against those values.

## Steps

1. **declarations** (mechanical): Stepgate queries OpenFEMA for the state and date range and keeps each declaration's number, date, title, declaration type, incident type and four program flags, with the API's total count. Gates stop the run if the start date is after the end date, or if the range holds more declarations than one call returns.
2. **summary** (mechanical): Stepgate groups the declarations by incident type with a count each, and lists which opened Individuals and Households, Individual Assistance, Public Assistance and Hazard Mitigation.
3. **brief**: the agent writes a Markdown brief with Overview, By incident type, By program and Declarations sections. Gates check the sections are in order, every declaration is cited as `[FEMA-<number>]` and no other number is cited, and every bold count line matches the summary.

## Inputs

| Input | Meaning |
|---|---|
| `state` | Two-letter USPS state or territory code, for example `TX` |
| `start_date` | First declaration date to include, `YYYY-MM-DD` |
| `end_date` | Last declaration date to include, `YYYY-MM-DD`, inclusive |

## Credentials

None needed. OpenFEMA is public and takes no key.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "disaster-declaration-brief"]
    }
  }
}
```

Then call the `disaster-declaration-brief` tool with `{ "state": "TX", "start_date": "2024-01-01", "end_date": "2025-12-31" }`, which returns 12 declarations (fires, floods and Hurricane Beryl). The brief is in `outputs.brief.markdown`, and the grouped counts are in `outputs.summary`.

OpenFEMA only accepts its query options with a `$` prefix (`$filter`, `$top`), so the query is written into the operation's path template and a call fills in only the state and the two dates. One call returns up to 1,000 declarations, which Stepgate reads whole since no model reads the response; a range with more stops at step 1 and needs narrowing. The agent is shown every declaration in step 3, so keep ranges to a few years.
