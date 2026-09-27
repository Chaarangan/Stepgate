# hubspot-deal-to-monday

Turns a closed-won HubSpot deal into kickoff drafts on a monday.com board. It reads the deal, refuses it unless its stage is closed won, reads the deal's line items, contacts and companies, plans one monday.com item per line item, and creates those items in a new group whose name starts with "Stepgate draft", each carrying an update with the deal, line item, company and contact details. Gates check every value against the HubSpot responses and check every monday.com write against the plan and the write results.

Status: validated against the vendors' documented APIs and offline gate tests, but not yet run live against a HubSpot or monday.com account.

## Steps

1. **deal**: reads the deal and then its pipeline stage. Gates check that the deal id is the input id, that the name, amount, close date, currency, pipeline and stage are copied from the deal response, and that the stage label, probability and closed flag come from a stage read made with the deal's own pipeline and stage. A last gate refuses the deal unless the stage's probability is 1.0 and HubSpot does not mark it open, so nothing is written for an open or closed-lost deal.
2. **records**: lists the deal's associated line items, contacts and companies with the v4 associations API, then batch reads each set. Gates check that all three association lists were fetched for the input deal only, that each list in the output holds every associated id exactly once and no other, and that every line item (name, quantity, price, amount, SKU), contact (name, email, phone, job title) and company (name, domain) is copied from a batch read result.
3. **plan**: lists exactly the writes. Gates check the board is the input board, the group is named `Stepgate draft: <deal name> (HubSpot deal <id>)`, there is one item per line item named `[Draft] <line item name> (HubSpot line item <id>)`, and each update body matches a template the gate rebuilds from the recorded deal, line item, company and contact values.
4. **create**: makes the writes through the monday.com GraphQL API. The tool accepts only three fixed mutation documents (create_group, create_item and create_update), so the model supplies variables and never writes GraphQL. Gates check that no other mutation was sent, that every call succeeded (no HTTP error, no `errors` array, a non-null id), that there was exactly one group, one item per planned item and one update per item and nothing else, that each call's variables equal the plan, and that the reported group, item and update ids are the ids those calls returned.
5. **report**: writes a Markdown summary with Deal, Drafts created and Next steps sections. Gates check the sections are in order, every created item is cited as `monday item <id>` with no other item id, every update id and the group id appear, and the deal is named with its id, name and stage label.

HubSpot deal stages are pipeline-specific internal ids. In the default pipeline the closed-won stage is `closedwon`, but other pipelines use generated ids such as `11348547`. The stepfile therefore does not match a stage name: it reads the stage from the Pipelines API and treats a probability of 1.0 as closed won, which is how HubSpot defines it.

## Inputs

| Input | Meaning |
|---|---|
| `deal_id` | HubSpot deal record id, the number at the end of the deal's URL |
| `board_id` | monday.com board id to create the draft group in, the number in the board's URL |

The deal must have at least one line item; a deal with none stops at the records step.

## Credentials

| Credential | Variable | Value | Minimum scopes |
|---|---|---|---|
| `hubspot` | `HUBSPOT_API_KEY` | A HubSpot private app access token, from Settings, Integrations, Private Apps, sent as `Authorization: Bearer <token>` | `crm.objects.deals.read`, `crm.objects.line_items.read`, `crm.objects.contacts.read`, `crm.objects.companies.read` |
| `monday` | `MONDAY_API_KEY` | A monday.com personal API token, from the Developer Center under My access tokens, sent as the raw `Authorization` header value with no `Bearer` prefix | A personal token carries its user's permissions, so the user needs edit rights on the target board |

Every monday.com request also carries `API-Version: 2026-07`, fixed in the stepfile and not visible to the model. That version is monday.com's current version until 1 October 2026, after which it moves to maintenance; update the pinned value when it is deprecated.

## Writes

HubSpot is only read. In monday.com, on the input board only, the run creates:

- one new group named `Stepgate draft: <deal name> (HubSpot deal <id>)`;
- one item per line item in that group, named `[Draft] <line item name> (HubSpot line item <id>)`;
- one update on each of those items with the deal, line item, company and contact details.

It creates no board, sets no column values, and changes, moves, archives or deletes nothing that already exists. Everything it creates is a draft for a person to review, assign and move out of the group. If a write fails, the create step stops without retrying it, because a retried write can create a duplicate; check the group for what was made before running again.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "hubspot-deal-to-monday"],
      "env": { "HUBSPOT_API_KEY": "pat-na1-...", "MONDAY_API_KEY": "eyJhbGciOi..." }
    }
  }
}
```

Then call the `hubspot-deal-to-monday` tool with `{ "deal_id": "21678228008", "board_id": "1234567890" }`, using a closed-won deal and a board from your own accounts. The report is in `outputs.report.markdown`, and the created ids are in `outputs.create`.

The associations step reads at most 500 associated records of each type and each batch read at most 100, which covers ordinary deals.
