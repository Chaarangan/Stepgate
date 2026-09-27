# servicenow-incident-review

Takes a ServiceNow incident number and a GitHub repository, reads the incident, lists every commit and merged pull request on the deployed branch in the hours before the incident opened, and builds a timeline and a short list of suspect changes. It then adds the review to the incident as an internal work note, once a person approves it. Stepgate makes every lookup and computes the window itself, so no SHA, pull request number, title or time can be misread; the agent orders the timeline, picks the suspects and writes the review, and gates check each against the listed changes.

Status: validated against the vendors' documented APIs (ServiceNow Table API, GitHub REST API version 2026-03-10) and offline gate tests built from documented responses, but not yet run live against a ServiceNow instance.

## Steps

1. **incident** (mechanical): Stepgate finds the incident with `findIncident` (query `number=<incident>`), reads its assignment group and work notes with `getIncidentNotes`, converts ServiceNow's UTC `YYYY-MM-DD HH:MM:SS` to `YYYY-MM-DDTHH:MM:SSZ`, and sets the window to end when the incident opened and start `lookback_hours` earlier, across day, month and year boundaries. A number that matches no incident stops the run at the second call.
2. **changes** (mechanical): Stepgate lists up to 100 commits on the branch in the window and searches up to 100 pull requests merged into it, and records every change and the incident's opening and resolution as events with a ref (the full SHA, `#number`, or `incident-opened` and `incident-resolved`), a time and a title. A gate stops the run if either list is longer than one page.
3. **analyse**: the agent orders the events into a timeline with a one-line summary each, picks the suspect changes with a reason, and writes a plain-text review. Stepgate derives the timeline's times and kinds from the events and the work note: a header naming the incident, window and repository, the suspects, then the review. Gates check the timeline lists every event once, oldest first; that each suspect is a listed commit or pull request; and that the review names the incident and every suspect and cites no SHA or `#number` outside the listed changes. Then a person approves the work note.
4. **note** (mechanical): Stepgate adds the approved work note with `addWorkNote` and records the `sys_id`, number and `sys_updated_on` ServiceNow returns. A gate checks ServiceNow answered for the same incident.
5. **report** (mechanical): Stepgate returns a Markdown report with the timeline, the review and when the work note was added.

The analyse step needs an MCP client that supports form elicitation, since that is how Stepgate asks the person to approve the note.

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

Exactly one, after a person approves its text: a work note on the incident, through `PATCH /api/now/table/incident/{sys_id}` with a body of `{ "work_notes": "..." }`. Work notes are internal journal entries that only fulfillers see; the stepfile never writes `comments`, the customer-visible field, and changes no other field. Nothing is written to GitHub.

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

The report is in `outputs.report.summary` and the work note's `sys_id`, number and timestamp in `outputs.note` (earlier versions put them in `outputs.execute.updated`).

GitHub's REST API cannot trim its responses; Stepgate reads them whole, since no model reads them. A window with more than 100 commits or 100 merged pull requests stops the run, so keep `lookback_hours` small on a busy branch. Merged pull requests are found by `base:<branch>`, so changes that reached the branch by a direct push appear only as commits.
