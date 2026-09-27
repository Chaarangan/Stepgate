# regulatory-change-monitor

Searches the Federal Register for final rules and proposed rules published in a date range, filtered by a full-text topic, an agency, or both, and writes a brief of the ones that matter. Every document number, title, type, publication date, agency name, effective date and comment-close date in the result is checked against what the Federal Register API returned, so a model cannot cite a rule that does not exist or move a deadline.

## Steps

1. **search**: runs at least one search for final rules (`RULE`) and one for proposed rules (`PRORULE`) over the date window, and submits every returned document as a candidate. Gates check that both types were searched, that every search used the exact start and end dates and the topic and agency from the inputs, that each candidate's number, title, type, publication date and agency names match a search result, that no returned document was dropped or listed twice, and that the reported counts are the counts the API gave.
2. **triage**: decides for every candidate whether it matters, with a reason, and fetches full detail for each one that does. Gates check that every candidate is decided exactly once, that at least one matters when there were any, that details exist for exactly the kept documents, and that each detail's action, citation, effective date and comment-close date match the fetched document, including nulls.
3. **brief**: writes one item per kept document with a priority and why it matters, and a Markdown brief with Summary, Final rules, Proposed rules and Key dates sections. Gates check the sections are in order, that the items are exactly the kept documents with titles, types and dates copied from the earlier steps, that the brief cites every item's document number and no other, and that every `YYYY-MM-DD` date in it is one of the run's dates or an item's publication, effective or comment-close date.

## Inputs

| Input | Meaning |
|---|---|
| `topic` | Full-text search term, for example `drone`. Give a topic, an agency, or both. |
| `agency` | Federal Register agency slug, for example `federal-aviation-administration`. The slug is the last part of the agency's page URL on federalregister.gov. |
| `start_date` | First publication date to include, `YYYY-MM-DD` |
| `end_date` | Last publication date to include, `YYYY-MM-DD` |

## Credentials

None. The Federal Register API needs no key or account.

## Run it

```sh
npx -y stepgate regulatory-change-monitor
```

Then call the `regulatory-change-monitor` tool with:

```json
{ "topic": "drone", "agency": "federal-aviation-administration", "start_date": "2026-01-01", "end_date": "2026-09-25" }
```

That window returned three final rules and two proposed rules when this entry was written. The brief is in `outputs.brief.summary`, and the structured items in `outputs.brief.items`.

Each search asks for six results at a time and full detail is fetched one document per call, because a search result or a document record can run to several thousand characters and larger batches would be cut at Stepgate's default 20,000-character tool result limit. A search with more than six matches can be paged up to page 3, and the API's total counts are kept in `outputs.search.rule_count` and `outputs.search.proposed_rule_count`.
