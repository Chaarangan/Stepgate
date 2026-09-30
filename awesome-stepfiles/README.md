# Awesome Stepfiles

Community stepfiles, reviewed and shipped with Stepgate, grouped into domain folders such as `marketing/`. Each entry runs by name:

```sh
npx -y stepgate --list            # the catalog, by domain
npx -y stepgate market-research   # serve one over stdio
```

Every folder has a README with what the stepfile does, its inputs, and the credentials it needs. A stepfile does not need to be here to run: pass the path of your own file instead of a catalog name ([docs/connect.md](../docs/connect.md#your-own-stepfiles)).

## Index

| Domain | Stepfile | What it does | Credentials |
|---|---|---|---|
| data | [airtable-field-completeness](data/airtable-field-completeness/) | Audit an Airtable table for empty required fields | `airtable` |
| data | [snowflake-metric-to-jira](data/snowflake-metric-to-jira/) | Check a Snowflake metric against a threshold and open a draft Jira issue on breach | `snowflake`, `jira` |
| engineering | [dependency-upgrade-risk](engineering/dependency-upgrade-risk/) | Upgrade risk for npm dependencies | None |
| engineering | [servicenow-incident-review](engineering/servicenow-incident-review/) | Incident review from ServiceNow and GitHub | `servicenow`, `github` |
| finance | [sec-10k-ratio-extraction](finance/sec-10k-ratio-extraction/) | Financial ratios from a company's latest 10-K | None |
| health | [drug-shortage-watch](health/drug-shortage-watch/) | Formulary check against the FDA drug shortage list | None |
| insurance | [auto-claim-vin-validation](insurance/auto-claim-vin-validation/) | Auto claim vehicle check against the VIN and NHTSA recalls | None |
| legal | [regulatory-change-monitor](legal/regulatory-change-monitor/) | Federal Register rules and proposed rules for a topic or agency | None |
| marketing | [github-release-to-customers](marketing/github-release-to-customers/) | Customer release notes from a GitHub release, drafted in Gmail for HubSpot contacts | `github`, `hubspot`, `gmail` |
| marketing | [market-research](marketing/market-research/) | Market research report for a brand | `tavily` |
| media | [book-list-verification](media/book-list-verification/) | Verify a reading list against Open Library | None |
| productivity | [meeting-scheduler](productivity/meeting-scheduler/) | Find meeting slots free for every attendee and draft the invite in Gmail | `google-calendar`, `gmail` |
| public | [disaster-declaration-brief](public/disaster-declaration-brief/) | Federal disaster declarations brief for a US state | None |
| research | [reference-list-validation](research/reference-list-validation/) | Validate a reference list against Crossref | None |
| sales | [hubspot-deal-to-monday](sales/hubspot-deal-to-monday/) | Draft a monday.com kickoff group from a closed-won HubSpot deal | `hubspot`, `monday` |
| security | [cve-triage-prioritisation](security/cve-triage-prioritisation/) | Prioritise CVEs by severity, exploitation probability and known exploitation | None |
| support | [zendesk-jira-escalation](support/zendesk-jira-escalation/) | Escalate Zendesk tickets to Jira as draft issues with internal notes | `zendesk`, `jira` |
| travel | [event-weather-contingency](travel/event-weather-contingency/) | Weather go, contingency or postpone call for an outdoor event | None |

## Add yours

A stepfile is worth sharing when it turns a task people repeat into steps with real checks. You need Node.js 22.18 or later.

1. Fork the repository, then run `npm run new-stepfile -- <domain>/<id>` in `server/`, choosing an existing domain folder where one fits. It creates `awesome-stepfiles/<domain>/<id>/` with a working stepfile and a README.
2. Write the procedure. [docs/stepfile.md](../docs/stepfile.md) explains every field, and [marketing/market-research](marketing/market-research/) is a complete example.
3. Replace every `TODO(<id>)` marker.
4. Add `<id>.cases.yaml` with recorded calls and outputs, so `stepgate --test <id>` and CI check your gates offline ([docs/stepfile.md](../docs/stepfile.md#testing-gates-offline)). Running Stepgate with `--record-cases <dir>` writes one from a real run; trim it and remove anything personal.
5. Add a row for your entry to the [index](#index), then run `npm run check` in `server/`.
6. Run it once against a real model and API, and open a pull request that changes only your folder and its index row.

### With a coding assistant

Claude Code, Cursor, Copilot or any other coding assistant can write the entry with you. It works best with Stepgate's authoring tools, which let it read the format, inspect the API, validate its draft and try it. From the repository root in Claude Code:

```sh
claude mcp add stepgate -- npx -y stepgate
```

Other clients are set up the same way, with no stepfile arguments ([docs/connect.md](../docs/connect.md#writing-stepfiles-with-an-agent)). Then point the assistant at these files:

| File | Why |
|---|---|
| `awesome-stepfiles/README.md` | The rules an entry must meet, and the index to add it to (this file) |
| `docs/stepfile.md` | Every field, and how gates and cases files work |
| `awesome-stepfiles/marketing/market-research/` | A complete entry to copy the shape of |
| `awesome-stepfiles/media/book-list-verification/` | A complete `<id>.cases.yaml` |
| The API's OpenAPI document or MCP server URL | The operations the steps will call |

A prompt that covers the whole job:

> Add a catalog entry `science/earthquake-brief` that summarises the week's earthquakes above a magnitude near a place, using the USGS Earthquake Catalog API. Run `npm run new-stepfile -- science/earthquake-brief` in `server/`, then follow the rules in `awesome-stepfiles/README.md` and the format in `docs/stepfile.md`, copying the shape of `marketing/market-research`. Use `stepgate_inspect_api` on the API, give every step gates that check real properties of the output, and `stepgate_try` the draft with a real place. Replace every `TODO(earthquake-brief)`, write `earthquake-brief.cases.yaml`, fill in the README, add a row to the index in `awesome-stepfiles/README.md`, and run `npm run check` until it passes.

Before opening the pull request, read the gates yourself. An assistant can make a gate pass by weakening it, and only you can tell a gate that checks the output from one that checks its shape.

### What an entry must meet

- **Layout.** It lives in `awesome-stepfiles/<domain>/<id>/` as `<id>.stepfile.yaml`, a `README.md` and an `<id>.cases.yaml`. The folder name equals the stepfile's `id`, and no other domain uses that `id`.
- **APIs.** It calls only public `https` APIs and MCP servers, and declares every credential with a clear `description`.
- **Gates.** Every step has gates that check real properties of the output, not just its shape.
- **Writes.** It writes only from a mechanical step that follows an agent step with an `approve` gate, using only inputs, settings and earlier steps' outputs. What reaches an API is then what a person approved.
- **Reads.** An operation counts as a write unless it is an OpenAPI GET, HEAD or OPTIONS, or its `exposes` entry declares `effect: read`. Declare that only where the API's documentation says the operation changes nothing.
- **Content.** It contains no secrets, personal data, or anything tied to one model or provider.

`npm run check` enforces the structural rules, and CI runs it on every pull request. Not sure what to build? [Suggest an idea](https://github.com/Chaarangan/stepgate/issues/new?template=stepfile_idea.yml), or pick one someone else suggested.
