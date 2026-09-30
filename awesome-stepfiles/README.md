# Stepfile catalog

Community stepfiles, reviewed and shipped with Stepgate, grouped into domain folders such as `marketing/`. Each entry runs by name:

```sh
npx -y stepgate --list            # the catalog, by domain
npx -y stepgate market-research   # serve one over stdio
```

Every folder has a README with what the stepfile does, its inputs, and the credentials it needs.

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

A stepfile does not need to be here to run: pass the path of your own file to `stepgate` instead of a catalog name, as [docs/connect.md](../docs/connect.md#your-own-stepfiles) describes. The catalog is for stepfiles worth sharing.

## Add yours

A stepfile is worth sharing when it turns a task people repeat into steps with real checks. You need Node.js 22.18 or later.

1. Fork the repository, then run `npm run new-stepfile -- <domain>/<id>` in `server/`, choosing an existing domain folder where one fits. It creates `awesome-stepfiles/<domain>/<id>/` with a working stepfile and a README.
2. Write the procedure. [docs/stepfile.md](../docs/stepfile.md) explains every field, and [marketing/market-research](marketing/market-research/) is a complete example.
3. Replace every `TODO(<id>)` marker, and add `<id>.cases.yaml` with recorded calls and outputs, so `stepgate --test <id>` and CI check your gates offline ([docs/stepfile.md](../docs/stepfile.md#testing-gates-offline)). Running Stepgate with `--record-cases <dir>` writes one from a real run; trim it and remove anything personal. Then run `npm run check` in `server/`.
4. Run it once against a real model and API, and open a pull request that changes only your folder.

A catalog entry must:

- live in `awesome-stepfiles/<domain>/<id>/`, as `<id>.stepfile.yaml`, a `README.md` and an `<id>.cases.yaml`, with the folder name equal to the stepfile's `id`, and an `id` no other domain uses;
- call only public `https` APIs and MCP servers, and declare every credential with a clear `description`;
- give every step gates that check real properties of the output, not just its shape;
- write only from a mechanical step, after an agent step with an `approve` gate, using only inputs, settings and earlier steps' outputs, so what reaches an API is what a person approved. An operation counts as a write unless it is an OpenAPI GET, HEAD or OPTIONS, or its `exposes` entry declares `effect: read`; declare that only where the API's documentation says the operation changes nothing;
- contain no secrets, personal data, or anything tied to one model or provider.

`npm run check` enforces the structural rules, and CI runs it on every pull request. Not sure what to build? [Suggest an idea](https://github.com/Chaarangan/stepgate/issues/new?template=stepfile_idea.yml), or pick one someone else suggested.
