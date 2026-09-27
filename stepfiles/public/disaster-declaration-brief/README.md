# disaster-declaration-brief

Writes a brief on the federal disaster declarations FEMA made for a US state over a date range, from the OpenFEMA FEMA Web Disaster Declarations dataset. Every declaration is listed with its FEMA disaster number, grouped by incident type and by the assistance programs it opened, and gates check each number, date, type, program flag and count against the API response before the brief is accepted.

## Steps

1. **declarations**: queries OpenFEMA for the state and date range, paging by 50 until every declaration is fetched. Gates check the date range is valid, every call used the input state and dates, every declaration (number, date, title, declaration type, incident type and the four program flags) is a row the API returned, `total_count` is the API's own count, and the list holds that many distinct declarations.
2. **summary**: groups the declarations by incident type and lists which opened Individuals and Households, Individual Assistance, Public Assistance and Hazard Mitigation. Gates check every declaration sits in exactly one group, in the group named by its own incident type, that each count equals its list, and that each program lists exactly the declarations whose flag is true.
3. **brief**: writes a Markdown brief with Overview, By incident type, By program and Declarations sections. Gates check the sections are in order, every declaration is cited as `[FEMA-<number>]` and no other number is cited, and every bold count line matches the summary.

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

OpenFEMA only accepts its query options with a `$` prefix (`$filter`, `$top`), which model APIs do not allow in tool argument names. The query is therefore written into the operation's path template, and the model fills in only the state, the two dates and the page offset. Each page is at most 50 rows, about 15,000 characters. A range with many hundreds of declarations needs many pages and a long first step, so keep ranges to a few years.
