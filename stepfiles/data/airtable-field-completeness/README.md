# airtable-field-completeness

Audits one Airtable table for empty required fields: for each of up to 100 records it reports which of the fields you name are empty, then summarises the incomplete records. A model asked to do this in chat tends to skip records, invent record ids, or call a field filled because a neighbouring record fills it. Here every record id, every field name and every "empty" verdict is checked against what Airtable returned. Airtable leaves empty fields out of a record, so a field counts as empty exactly when the record's `fields` has no key for it.

Status: validated against Airtable's documented Web API and with offline gate tests (`stepgate --test airtable-field-completeness`).

## Steps

1. **schema**: reads the base schema and finds the table. Gates check the table is the one named in `table`, that its id, name and field names are copied from the schema, and that `missing_fields` is exactly the requested fields the table does not have.
2. **records**: lists up to 100 records with only the requested fields. Gates check there is one successful call on the schema step's table id with exactly the fields the table has, that every returned record is submitted once, that each record's `empty` is exactly the checked fields its `fields` leave out, and that `more_records` is true exactly when Airtable returned an `offset`.
3. **report**: counts and summarises. Gates check the counts and the list of incomplete ids against the records step, that the summary has its two sections in order, names every incomplete record, and names no record that was not audited.

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
