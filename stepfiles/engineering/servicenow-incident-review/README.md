# servicenow-incident-review

Takes a ServiceNow incident number and a GitHub repository, reads the incident, lists every commit and merged pull request on the deployed branch in the hours before the incident opened, and builds a timeline and a short list of suspect changes. It then adds the review to the incident as an internal work note. Every commit SHA, pull request number, title and time in the result is checked against the GitHub response it came from, every incident field against the ServiceNow record, and the work note against the plan the model wrote before making it.

Status: validated against the vendors' documented APIs (ServiceNow Table API, GitHub REST API version 2026-03-10) and offline gate tests built from documented and real responses, but not yet run live against a ServiceNow instance.

## Steps

1. **incident**: finds the incident with `findIncident` (query `number=<incident>`) and reads its assignment group and work notes with `getIncidentNotes`. Gates check that sys_id, short description, state, priority and the opened and resolved times are the record's own, with ServiceNow's UTC `YYYY-MM-DD HH:MM:SS` converted to `YYYY-MM-DDTHH:MM:SSZ`; that the group name and whether work notes exist match the record; and that the window ends when the incident opened and starts exactly `lookback_hours` earlier. The window check converts both times to seconds, so it holds across day, month and year boundaries.
2. **changes**: pages through `listCommits` for the branch and window, two commits a page, and searches merged pull requests into that branch within the window. Gates check that every call used the incident window, that every page from 1 to the short last page was read, that each commit's SHA, commit time and first message line and each pull request's number, title and merge time are copied from a response, that nothing returned was dropped or repeated (pull requests against the search's `total_count`), that every search result belongs to this repository, and that everything falls inside the window.
3. **analyse**: builds the timeline and picks suspect changes. Gates check the timeline holds exactly one entry per commit, pull request and incident event with its real time, sorted oldest first; that each suspect is a listed change with its own time inside the window; and that the summary names the incident and every suspect and cites no 40-character SHA or `#number` outside the evidence.
4. **plan**: writes the single work note. Gates check it targets this incident's sys_id, starts with `Incident review for <incident>`, states the window, names every suspect and cites only listed commits and pull requests.
5. **execute**: may call only `addWorkNote`. Gates check from the calls themselves that every call carried exactly a planned sys_id and note text, that each planned note succeeded exactly once, that ServiceNow answered for the same record, and that the reported sys_id, number and `sys_updated_on` come from that answer.
6. **report**: writes a Markdown report. Gates check it names the incident, every suspect and the work note's `sys_updated_on`, and cites only changes from the timeline.

## Inputs

| Input | Meaning |
|---|---|
| `incident_number` | The incident number as ServiceNow shows it, for example `INC0010042` |
| `owner`, `repo` | The GitHub repository, for example `cli` and `cli` |
| `branch` | The branch that was deployed, for example `main` |
| `lookback_hours` | How many hours before the incident opened to search, 1 to 72 |

## Settings

| Setting | Environment variable | Meaning |
|---|---|---|
| `servicenow-instance` | `SERVICENOW_INSTANCE` | Your instance name, the `acme` in `acme.service-now.com` |

## Credentials

| Credential | Environment variable | Value | Minimum access |
|---|---|---|---|
| `servicenow` | `SERVICENOW_API_KEY` | `user:password` of a ServiceNow user, sent as HTTP Basic | Read incidents and write their work notes, usually the `itil` role |
| `github` | `GITHUB_API_KEY` | A GitHub personal access token, sent as `Authorization: Bearer` | Fine-grained: read-only Contents and Pull requests on the repository. Classic: `repo` for a private repository, no scope for a public one |

GitHub's `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10` headers are fixed in the stepfile and sent on every call. Unauthenticated access to GitHub would work for a public repository, but the stepfile always sends the token, and the search endpoint allows 30 authenticated requests a minute.

## Writes

Exactly one: a work note on the incident, through `PATCH /api/now/table/incident/{sys_id}` with a body of `{ "work_notes": "..." }`. Work notes are internal journal entries that only fulfillers see; the stepfile never writes `comments`, the customer-visible field, and changes no other field. Nothing is written to GitHub.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "servicenow-incident-review"],
      "env": {
        "SERVICENOW_INSTANCE": "acme",
        "SERVICENOW_API_KEY": "integration.user:password",
        "GITHUB_API_KEY": "github_pat_..."
      }
    }
  }
}
```

Then call the `servicenow-incident-review` tool with:

```json
{ "incident_number": "INC0010042", "owner": "cli", "repo": "cli", "branch": "trunk", "lookback_hours": 24 }
```

For an incident opened at 2026-09-15 14:00:00 UTC, the window on `cli/cli` holds 15 commits on `trunk` and 8 merged pull requests, which is what the offline tests use. The report is in `outputs.report.summary` and the work note's timestamp in `outputs.execute.updated`.

GitHub's REST API cannot trim its responses, so a commit takes about 5,000 characters and a search item more once its body is counted. That is why commits come two per page and the model is told to fetch a search item alone when a page is cut off at `--tool-result-chars`. A busy branch or a long window therefore means many calls in the changes step; keep `lookback_hours` small or raise `--calls-per-step` if a run stops with `CallLimitReached`. Merged pull requests are found by `base:<branch>`, so changes that reached the branch by a direct push appear only as commits.
