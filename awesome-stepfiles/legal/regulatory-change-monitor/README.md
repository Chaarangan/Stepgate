# regulatory-change-monitor

Searches the Federal Register for final rules and proposed rules published in a date range, filtered by a full-text topic, an agency, or both, and writes a brief of the ones that matter. Stepgate makes the searches and fetches each kept document itself, so no document number, title, type, date or agency name can be misread or invented; the agent decides which documents matter and writes the brief, and gates check it against those values.

## Steps

1. **search** (mechanical): Stepgate searches final rules (`RULE`) and proposed rules (`PRORULE`) over the date window with the topic and agency from the inputs, and keeps every returned document as a candidate with its number, title, type, publication date and agency names, plus the API's total count for each type.
2. **triage**: the agent decides for every candidate whether it matters, with a reason. Gates check that every candidate is decided exactly once, that no other number appears, and that at least one matters when there were any.
3. **details** (mechanical): Stepgate fetches each document judged to matter and keeps its title, type, publication date, action, citation, effective date and comment-close date.
4. **brief**: the agent gives each kept document a priority and why it matters, and writes a Markdown brief with Summary, Final rules, Proposed rules and Key dates sections. Stepgate builds `items` from those assessments and step 3's details. Gates check the sections are in order, that the assessments are exactly the kept documents, that the brief cites every kept document's number and no other, and that every `YYYY-MM-DD` date in it is one of the run's dates or a kept document's publication, effective or comment-close date.

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

That window returned three final rules and two proposed rules when this entry was written. The brief is in `outputs.brief.summary`, and the structured items in `outputs.brief.items`. The fetched details of the kept documents are in `outputs.details.details`, not under `outputs.triage`.

Each search takes the 20 newest documents of its type; the API's total counts are kept in `outputs.search.rule_count` and `outputs.search.proposed_rule_count`, so a window with more matches than that shows up there. Stepgate reads the search and document responses itself, so their size does not reach the agent; the agent sees only the candidates and the kept documents' details.
