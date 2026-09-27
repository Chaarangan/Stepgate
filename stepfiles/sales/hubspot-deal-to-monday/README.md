# hubspot-deal-to-monday

Turns a closed-won HubSpot deal into kickoff drafts on a monday.com board. Stepgate reads the deal, refuses it unless its stage is closed won, reads the deal's line items, contacts and companies, and plans one monday.com item per line item in a new group whose name starts with "Stepgate draft", each carrying an update with the deal, line item, company and contact details. The agent writes a summary of that plan for a person, and nothing is written until the person approves it. Stepgate then makes every write from the approved plan, so no value on monday.com can differ from what HubSpot returned.

Status: validated against the vendors' documented APIs and offline gate tests, but not yet run live against a HubSpot or monday.com account.

## Steps

1. **deal** (mechanical): Stepgate reads the deal and then its pipeline stage. A gate refuses the deal unless the stage's probability is 1.0 and HubSpot does not mark it open, so nothing more is read or written for an open or closed-lost deal.
2. **records** (mechanical): Stepgate lists the deal's associated line items, contacts and companies with the v4 associations API and batch reads each set, keeping the order the associations were listed in. A record the batch read does not return stops the run.
3. **plan**: Stepgate derives the writes: the input board, the group name `Stepgate draft: <deal name> (HubSpot deal <id>)`, one item per line item named `[Draft] <line item name> (HubSpot line item <id>)`, and each item's update text. The agent writes a Markdown summary with Deal, Drafts to create and Next steps sections; gates check the sections are in order, the deal is named with its id, name and stage label, and every line item is cited as `HubSpot line item <id>` with no other id. The last gate asks a person to approve the group, items and update texts; nothing is written if they decline.
4. **group** (mechanical): Stepgate creates the approved group.
5. **items** (mechanical): Stepgate creates one approved item per line item in that group.
6. **updates** (mechanical): Stepgate adds each approved update to its item.

The approval in step 3 needs an MCP client that supports form elicitation. Steps 4 to 6 send only three fixed mutation documents (create_group, create_item and create_update), with variables taken from the approved plan and from the ids the earlier writes returned. monday.com reports an application error with HTTP 200 and an `errors` array, so a gate on each write step stops the run at the first write that failed and shows the errors.

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

It creates no board, sets no column values, and changes, moves, archives or deletes nothing that already exists. Everything it creates is a draft for a person to review, assign and move out of the group. If a write fails, the run stops at that step without retrying it, because a retried write can create a duplicate; check the group for what was made before running again.

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

Then call the `hubspot-deal-to-monday` tool with `{ "deal_id": "21678228008", "board_id": "1234567890" }`, using a closed-won deal and a board from your own accounts. The summary the person approved is in `outputs.plan.summary`, and the group id and each item's name, item id and update id are in `outputs.updates`. There is no longer a report step after the writes, so `outputs.report` and `outputs.create` are gone.

The records step reads at most 500 associated records of each type, and a batch read takes at most 100 ids, so a deal with more than 100 of one type stops there. That covers ordinary deals.
