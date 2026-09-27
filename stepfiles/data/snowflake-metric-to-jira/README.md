# snowflake-metric-to-jira

Runs one fixed, read-only SQL query in Snowflake, compares the metric it returns with a threshold, and opens a draft Jira issue only when the threshold is breached. The SQL is yours, supplied as an input and run character for character; the issue quotes the exact values Snowflake returned and carries the SQL in a code block. A model left to itself tends to tidy the query, round the number or decide a borderline value by feel; here the executed statement, every returned value and the breach decision are checked mechanically against the input and the API response.

Status: validated against the vendors' documented APIs (Snowflake SQL API v2, Jira Cloud REST API v3) and with offline gate tests, but not yet run live.

## Steps

1. **query**: runs the SQL once through the Snowflake SQL API and records the statement handle, the columns, the returned row and the metric. Gates check that the input is one `SELECT` or `WITH` statement with no semicolon except one at the end, that exactly one statement ran and it was the input SQL character for character with the input warehouse and role, that it finished and returned exactly one row, that the handle, columns and row are copied from the response, and that the metric is the value in the column named `metric_column`, a plain number.
2. **plan**: decides whether the threshold is breached and, if so, plans one Jira issue. Gates recompute the breach from the returned value (strictly greater than the threshold for `above`, strictly less for `below`), require an issue exactly when breached, fix the summary as `<metric_name> breached: <value>`, and require the description to start `<metric_name> (<metric_column>) returned <value>, <breach_when> the threshold <threshold>. ` and to quote the statement handle and every returned value exactly.
3. **execute**: creates the planned issue, or nothing when not breached. Gates check there is exactly one successful `createJiraIssue` call when breached and none otherwise, that its fields are exactly the plan's with the label `stepgate-draft` and the input SQL character for character in the code block, and that the key reported is the one Jira returned.
4. **report**: returns the SQL, value, threshold, verdict and key with a Markdown summary. Gates check each value is copied exactly and that the summary quotes the value and the SQL, and names the created key and no other key in the project (or none when nothing was created).

## Inputs

| Input | Meaning |
|---|---|
| `sql` | One `SELECT` or `WITH ... SELECT` statement returning exactly one row, for example `SELECT COUNT_IF(status = 'error') / COUNT(*) AS ERROR_RATE FROM analytics.checkout.events WHERE event_date = CURRENT_DATE()`. A semicolon is allowed only at the very end, so a semicolon inside a string literal is refused too. Qualify table names with database and schema. |
| `metric_name` | A human name for the metric, for example `Checkout error rate` |
| `metric_column` | The result column holding the metric as Snowflake names it; unquoted identifiers come back in upper case, so `error_rate` is `ERROR_RATE` |
| `threshold` | The number the metric is compared with |
| `breach_when` | `above` (breached when the metric is greater than the threshold) or `below` (less than) |
| `warehouse` | The warehouse to run the query in |
| `role` | The role to run the query as |
| `jira_project` | The Jira project key for the issue, for example `DATA` |
| `jira_issue_type` | The issue type name, for example `Task` |

## Settings

| Setting | Environment variable | Value |
|---|---|---|
| `snowflake-account` | `SNOWFLAKE_ACCOUNT` | Your account identifier as it appears in your account URL, in lower case: the `myorg-myaccount` in `myorg-myaccount.snowflakecomputing.com`. Letters, digits, and single `.`, `_` or `-` between them, so a legacy locator such as `xy12345.us-east-2.aws` also works. |
| `jira-site` | `JIRA_SITE` | Your Atlassian site name, the `acme` in `acme.atlassian.net` |

## Credentials

| Credential | Environment variable | Value | Minimum access |
|---|---|---|---|
| `snowflake` | `SNOWFLAKE_API_KEY` | The secret of a Snowflake programmatic access token. Stepgate sends it as `Authorization: Bearer` with `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`. | A user whose role (`role`) has USAGE on the warehouse, database and schema and SELECT on the tables the query reads, and nothing that writes. By default Snowflake requires a network policy on the user before a programmatic access token can be used. |
| `jira` | `JIRA_API_KEY` | `you@example.com:API_TOKEN`: an Atlassian account email and an API token created without scopes at id.atlassian.com/manage/api-tokens. | Browse projects and Create issues in the target project. |

Atlassian's API tokens with scopes only work through `api.atlassian.com/ex/jira/{cloudId}`, not through your site's own host, so this stepfile needs a token created without scopes. The SQL checks refuse anything but a single `SELECT` or `WITH` statement before it is sent, and the SQL API runs one statement per request unless told otherwise, which this stepfile never does; a read-only role is still the guard that matters, because a `SELECT` can call functions.

## Writes

- **Snowflake**: nothing. The one statement is your `SELECT`.
- **Jira**: at most one issue, and only when the threshold is breached, in `jira_project`, of type `jira_issue_type`, with the label `stepgate-draft`, the summary `<metric_name> breached: <value>`, and a description of one paragraph quoting the returned values and one code block holding the SQL. The request sets no assignee and no other field, so the issue is unassigned unless the project's default assignee is a person. When the threshold is not breached nothing is created, and the report says so.

A created issue is a draft for a person to review, marked by the `stepgate-draft` label.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "snowflake-metric-to-jira"],
      "env": {
        "SNOWFLAKE_ACCOUNT": "myorg-myaccount",
        "JIRA_SITE": "acme",
        "SNOWFLAKE_API_KEY": "<programmatic access token secret>",
        "JIRA_API_KEY": "you@example.com:API_TOKEN"
      }
    }
  }
}
```

Then call the `snowflake-metric-to-jira` tool with:

```json
{
  "sql": "SELECT COUNT_IF(status = 'error') AS ERRORS, COUNT(*) AS TOTAL, ROUND(ERRORS / NULLIF(TOTAL, 0), 4) AS ERROR_RATE FROM analytics.checkout.events WHERE event_date = CURRENT_DATE()",
  "metric_name": "Checkout error rate",
  "metric_column": "ERROR_RATE",
  "threshold": 0.02,
  "breach_when": "above",
  "warehouse": "REPORTING_WH",
  "role": "METRICS_READER",
  "jira_project": "DATA",
  "jira_issue_type": "Task"
}
```

The verdict is in `outputs.plan.breached`, the created key (or null) in `outputs.execute.jira_key`, and the report in `outputs.report.summary`.

The query must finish within the SQL API's 45 seconds for a synchronous answer; a slower query gets a "still running" response, which the gates reject and the run stops. The metric must be a plain number: a SQL NULL, text, or a value with thousands separators stops the run rather than being guessed at.
