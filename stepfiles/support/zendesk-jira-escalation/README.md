# zendesk-jira-escalation

Escalates Zendesk tickets to Jira. It finds open tickets that match an escalation rule (a priority and a tag), searches one Jira project for unresolved issues that already track each problem, and either links the ticket to an existing issue or creates a new Jira issue labelled `stepgate-draft`. Every handled ticket then gets an internal note naming the Jira key. A model left to itself tends to invent issue keys, pick tickets that do not match the rule or reply to the customer; here every ticket, key and write is checked against what Zendesk and Jira returned, and the only Zendesk write the model can make is a comment with `public: false`.

Status: validated against the vendors' documented APIs (Zendesk Support API, Jira Cloud REST API v3) and with offline gate tests, but not yet run live.

## Steps

1. **tickets**: runs one Zendesk search, `type:ticket status<pending priority:<priority> tags:<escalation_tag>`, sorted oldest first, and takes the first `max_tickets` results that are tickets with status new or open, that priority and that tag. Gates check that exactly one search was made with exactly that query, that the tickets submitted are exactly the first `max_tickets` matches in the order returned, that each ticket's subject, status, priority and tags are copied from the response, and that the total count is the response's.
2. **plan**: searches Jira for each ticket with JQL of the fixed form `project = "<jira_project>" AND statusCategory != Done AND text ~ "<words>"`, decides link or create per ticket, and lists exactly the Jira issues to create and the internal notes to add. Gates check one decision per ticket, that every JQL has that form (so a search cannot leave the project or include finished issues), that each decision's JQL was actually searched, that a linked key was returned by that very search, that creates carry the input project and issue type with the summary `[Zendesk #ID] SUBJECT` and a description naming the ticket, and that every note is the fixed text for its decision.
3. **execute**: creates the planned Jira issues and adds the planned internal notes, and nothing else. Gates check that every write succeeded, that there is one `createJiraIssue` call per planned create with exactly the planned fields, one `addZendeskInternalNote` call per planned note with `public: false` and exactly the planned body (for a created issue, with the key Jira returned for that ticket), that each update response is for the ticket written to, and that the keys reported come from the plan or from the create responses.
4. **report**: returns one row per ticket and a Markdown summary. Gates check the rows match the execute step and the tickets' subjects, and that the summary names every handled ticket as `#ID` and every Jira key, and no other ticket number or key in the project.

The internal note is `Stepgate escalation: linked to existing Jira issue KEY.` for a link and `Stepgate escalation: created draft Jira issue KEY.` for a create.

## Inputs

| Input | Meaning |
|---|---|
| `escalation_tag` | The Zendesk tag that marks a ticket for escalation, for example `escalate_eng` |
| `priority` | The Zendesk priority the tickets must have: `urgent`, `high`, `normal` or `low` |
| `max_tickets` | Most tickets to handle in one run, 1 to 10, oldest first |
| `jira_project` | The Jira project key to search and create in, for example `SUP` |
| `jira_issue_type` | The issue type name for created issues, for example `Bug` or `Task` |

## Settings

| Setting | Environment variable | Value |
|---|---|---|
| `zendesk-subdomain` | `ZENDESK_SUBDOMAIN` | Your Zendesk subdomain, the `acme` in `acme.zendesk.com` |
| `jira-site` | `JIRA_SITE` | Your Atlassian site name, the `acme` in `acme.atlassian.net` |

## Credentials

| Credential | Environment variable | Value | Minimum access |
|---|---|---|---|
| `zendesk` | `ZENDESK_API_KEY` | `you@example.com/token:API_TOKEN`: an agent's email, the literal text `/token`, a colon, then an API token created in Zendesk Admin Center. Stepgate sends it as HTTP Basic, which is Zendesk's API token scheme. | An agent who can see the matching tickets and add internal notes to them. A token acts with the full rights of that user, so use a dedicated agent. |
| `jira` | `JIRA_API_KEY` | `you@example.com:API_TOKEN`: an Atlassian account email and an API token created without scopes at id.atlassian.com/manage/api-tokens. | Browse projects and Create issues in the target project. |

Zendesk's security page marks API tokens as deprecated in favour of OAuth access tokens, but they still work. Atlassian's API tokens with scopes only work through `api.atlassian.com/ex/jira/{cloudId}`, not through your site's own host, so this stepfile needs a token created without scopes.

## Writes

- **Jira**: one issue per ticket with no existing unresolved issue for its problem, in `jira_project`, of type `jira_issue_type`, with the label `stepgate-draft`, the summary `[Zendesk #ID] SUBJECT` and a one-paragraph description naming the ticket. The request sets no assignee and no other field, so the issue is unassigned unless the project's default assignee is a person; set the default assignee to Unassigned if drafts must stay unassigned. Nothing else in Jira changes; a linked issue is not modified.
- **Zendesk**: one internal note (`public: false`) per handled ticket, naming the Jira key. No public reply is posted, and status, priority, tags and assignee are not changed. The tool's schema admits nothing but an internal comment.

Created issues are drafts for a person to review, marked by the `stepgate-draft` label and the "Created by Stepgate as a draft for review." sentence in their description.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "zendesk-jira-escalation"],
      "env": {
        "ZENDESK_SUBDOMAIN": "acme",
        "JIRA_SITE": "acme",
        "ZENDESK_API_KEY": "you@example.com/token:API_TOKEN",
        "JIRA_API_KEY": "you@example.com:API_TOKEN"
      }
    }
  }
}
```

Then call the `zendesk-jira-escalation` tool with:

```json
{ "escalation_tag": "escalate_eng", "priority": "urgent", "max_tickets": 5, "jira_project": "SUP", "jira_issue_type": "Bug" }
```

The decisions are in `outputs.plan.decisions`, what was written in `outputs.execute.results`, and the report in `outputs.report.summary`.

A run makes each write once and does not repeat one after a gate failure, so a failed execute step stops the run rather than creating duplicates; check the tickets named in the error before running again. The run does not change a ticket's tags, so a handled ticket still matches the rule and the next run would take it again; remove the escalation tag once a ticket is escalated, for example with a Zendesk trigger that fires on the internal note.
