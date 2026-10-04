# airtable-field-completeness

Audits one Airtable table for empty required fields: for each of up to 100 records it reports which of the fields you name are empty, then summarises the incomplete records. A model asked to do this in chat tends to skip records, invent record ids, or call a field filled because a neighbouring record fills it. Here Stepgate reads the schema and the records itself and works out which fields each record leaves empty, so no record or verdict can be skipped or invented; the agent only writes the summary, whose gates check it against those records. Airtable leaves empty fields out of a record, so a field counts as empty exactly when the record's `fields` has no key for it.

Status: validated against Airtable's documented Web API and with offline gate tests (`stepgate --test airtable-field-completeness`).

## Steps

1. **schema** (mechanical): Stepgate reads the base schema and keeps the table whose name, or else id, is `table`, with its field names. Gates stop the run if the base has no such table or the table has none of the requested fields.
2. **records** (mechanical): Stepgate lists up to 100 records with only the requested fields the table has, and records `checked` (those fields), `missing_fields` (the requested fields the table lacks), each record's `empty` fields, and `more_records`, true when Airtable returned an `offset`.
3. **report**: the agent writes a Markdown summary. Stepgate derives `audited`, the number of records, and `incomplete`, the ids of the records with an empty field. Gates check the summary has its two sections in order, names every incomplete record, and names no record that was not audited.

`missing_fields` moved from `outputs.schema` to `outputs.records`; `audited`, `incomplete` and `summary` are still in `outputs.report`.

## Inputs

| Input | Meaning |
|---|---|
| `base_id` | The base's id, the `app...` part of its URL |
| `table` | The table's name, or its `tbl...` id |
| `required_fields` | The field names every record should fill in, 1 to 10 of them |

## Credentials

| Credential | Environment variable | Value | Minimum access |
|---|---|---|---|
| `airtable` | `AIRTABLE_API_KEY` | An Airtable personal access token, created at airtable.com/create/tokens | The `data.records:read` and `schema.bases:read` scopes, on the base to audit only |

## Writes

None. Both operations are reads.

## Limits

One page of 100 records is audited. When the table has more, the report says only the first 100 were audited. Airtable allows 5 requests a second per base, and the audit makes two.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "airtable-field-completeness"],
      "env": { "AIRTABLE_API_KEY": "pat..." }
    }
  }
}
```

Then call the `airtable-field-completeness` tool with `{ "base_id": "appXXXXXXXXXXXXXX", "table": "Contacts", "required_fields": ["Email", "Owner"] }`.
