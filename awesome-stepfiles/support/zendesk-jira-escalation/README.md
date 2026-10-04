# zendesk-jira-escalation

Escalates Zendesk tickets to Jira. It finds open tickets that match an escalation rule (a priority and a tag), searches one Jira project for unresolved issues that already track each problem, and either links the ticket to an existing issue or creates a new Jira issue labelled `stepgate-draft`. Every handled ticket then gets an internal note naming the Jira key. A model left to itself tends to invent issue keys, pick tickets that do not match the rule or reply to the customer. Here the agent makes only the link-or-create decisions, which gates check against the Jira searches it made; Stepgate selects the tickets, writes the issue fields and notes, and makes every write itself after a person approves them, and the only Zendesk write is a comment with `public: false`.

Status: validated against the vendors' documented APIs (Zendesk Support API, Jira Cloud REST API v3) and with offline gate tests, but not yet run live.

## Steps

1. **tickets** (mechanical): Stepgate runs one Zendesk search, `type:ticket status<pending priority:<priority> tags:<escalation_tag>`, sorted oldest first, and takes the first `max_tickets` results that are tickets with status new or open, that priority and that tag.
2. **plan**: the agent searches Jira for each ticket with JQL of the fixed form `project = "<jira_project>" AND statusCategory != Done AND text ~ "<words>"` and decides link or create per ticket. Gates check one decision per ticket, that every JQL has that form (so a search cannot leave the project or include finished issues), that each decision's JQL was actually searched, that a linked key was returned by that very search, and that only a link has a key. Stepgate then derives the Jira issues to create (the input project and issue type, the summary `[Zendesk #ID] SUBJECT` and a one-line description naming the ticket) and the internal note for each ticket. The last gate asks a person to approve those issues and notes; nothing is written if they decline.
3. **create** (mechanical): Stepgate creates the approved Jira issues and records the key Jira returned for each ticket.
4. **note** (mechanical): Stepgate adds each approved internal note, with the key from step 3 in a created issue's note, and records the action and Jira key per ticket.
5. **report**: Stepgate lists one row per ticket and the agent writes a Markdown summary. A gate checks the summary names every handled ticket as `#ID` and every Jira key, and no other ticket number or key in the project.

The approval in step 2 needs an MCP client that shows form elicitation, such as Claude Code in a terminal ([connect.md](../../../docs/connect.md#approvals)). It covers both writes: the person sees each create note as `Stepgate escalation: created draft Jira issue {KEY}.`, and step 4 sends that text with `{KEY}` replaced by the key Jira returned in step 3. Every other value either write sends is one the person approved.

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

The decisions and the approved issues and notes are in `outputs.plan`, what was written in `outputs.note.outcomes` (it was `outputs.execute.results` before the writes became mechanical), and the report in `outputs.report.summary`, with its rows in `outputs.report.rows`.

A run makes each write once and does not repeat one after a gate failure, so a failed write stops the run at that step rather than creating duplicates; check the tickets named in the error before running again. The run does not change a ticket's tags, so a handled ticket still matches the rule and the next run would take it again; remove the escalation tag once a ticket is escalated, for example with a Zendesk trigger that fires on the internal note.
