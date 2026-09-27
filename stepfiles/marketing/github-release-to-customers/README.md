# github-release-to-customers

Takes a GitHub release tag and the tag before it, collects the pull requests merged between the two, writes customer-facing release notes that cite each change by pull request number, finds the HubSpot contacts matching a property filter, and creates a Gmail draft addressed to you with the notes and the recipient list. Stepgate itself fetches the releases, pull requests and contacts and builds the raw message, so the model only sorts the changes and writes the text; a person approves the email before Stepgate stores it as a Gmail draft. It creates a draft and never sends (see [Writes](#writes)).

Status: validated against the vendors' documented APIs (GitHub REST API version 2026-03-10, HubSpot CRM objects API version 2026-09, Gmail API v1) and offline gate tests (`github-release-to-customers.cases.yaml`) shaped like the vendors' documented responses, but not yet run live against a HubSpot account or a Gmail mailbox.

## Steps

1. **releases** (mechanical): Stepgate fetches both releases with `getReleaseByTag` and computes the merge window, from the previous release's `created_at` plus 2 seconds to the new one's plus 1 second. GitHub documents `created_at` as the date of the release's commit, and records a pull request's merge about a second after its merge commit, so this window keeps the previous release's own pull request out and the new release's in. On `cli/cli` v2.99.0 to v2.100.0 it gives exactly the 12 pull requests GitHub's own release notes list. A gate checks the previous release is older.
2. **pulls** (mechanical): Stepgate searches merged pull requests in that window, 100 a page, fetching as many pages as `total_count` needs. A gate checks the list holds `total_count` pull requests and GitHub did not report `incomplete_results`, so a release with more than GitHub's 1,000 search results stops here.
3. **notes**: the agent sorts each pull request into customer-facing items or excluded internal work and writes the notes. Gates check every pull request is sorted exactly once, and the notes mention the tag, cite every item as `#number` and cite no excluded or unknown number.
4. **audience** (mechanical): Stepgate searches HubSpot contacts with one `EQ` filter on the given property and value, 200 a page, and splits the results into contacts with an email and the ids of those without. A gate checks the page held every match, so more than 200 matching contacts stops the run; narrow the filter.
5. **email**: the agent writes the subject and body. Stepgate sets `to` to `operator_email`, `recipients` to the contacts' addresses (lowercased, each once), and builds `raw`, the RFC 2822 message: `To`, `Subject`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8` and `Content-Transfer-Encoding: 8bit`, an empty line, then the body, every line ending in CRLF. The subject must be one line, so no header can be added through it. Gates check the subject and body name the tag, and the body cites every note item and no other pull request number, and lists every recipient. Then a person is asked to approve the draft: the message shows the whole output, including `raw`, the exact message Gmail will store.
6. **draft** (mechanical): Stepgate calls `createDraft`, Gmail's `drafts.create` media upload, with the approved `raw`, and records the draft's `id` and `message.id`.

The approval in step 5 needs an MCP client that supports form elicitation; on one that does not, the run fails before its first step.

## Inputs

| Input | Meaning |
|---|---|
| `owner`, `repo` | The GitHub repository, for example `cli` and `cli` |
| `tag` | The release to announce, for example `v2.100.0` |
| `previous_tag` | The release before it, for example `v2.99.0` |
| `contact_property` | Internal name of a HubSpot contact property, for example `lifecyclestage` |
| `contact_value` | The value it must equal, for example `customer` |
| `operator_email` | Who the prepared email is addressed to |

## Credentials

| Credential | Environment variable | Value | Minimum access |
|---|---|---|---|
| `github` | `GITHUB_API_KEY` | A GitHub personal access token, sent as `Authorization: Bearer` | Fine-grained: read-only Contents and Pull requests on the repository. Classic: `repo` for a private repository, no scope for a public one |
| `hubspot` | `HUBSPOT_API_KEY` | A HubSpot private app access token, sent as `Authorization: Bearer` | The `crm.objects.contacts.read` scope |
| `gmail` | `GMAIL_API_KEY` | A Google OAuth 2.0 access token for the mailbox that should hold the draft, sent as `Authorization: Bearer` | The `https://www.googleapis.com/auth/gmail.compose` scope |

GitHub's `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10` headers are fixed in the stepfile and sent on every call. HubSpot now lists private apps as legacy apps; they remain supported. Google access tokens expire after about an hour and Stepgate does not refresh them, so fetch a fresh one before each run.

## Writes

One Gmail draft, never sent, created only after you approve it in step 5. The draft step posts the approved raw message to `https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media` with `Content-Type: message/rfc822`, so nothing is base64-encoded. The stepfile exposes no send operation. The draft is addressed to `operator_email` only; the customer addresses are listed in its body for you to review and send from your mail client. HubSpot's contact search is sent as a POST but only reads, as HubSpot documents, so the stepfile declares it `effect: read`.

The message has no `From` header. The Gmail API pages this was checked against do not say whether a draft needs one or what Gmail fills in (their examples set one), so check the sender when you open the draft. A subject with non-ASCII characters is sent as UTF-8 rather than RFC 2047 encoded words, which has not been tried against Gmail.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "github-release-to-customers"],
      "env": {
        "GITHUB_API_KEY": "github_pat_...",
        "HUBSPOT_API_KEY": "pat-na1-...",
        "GMAIL_API_KEY": "ya29...."
      }
    }
  }
}
```

Then call the `github-release-to-customers` tool with:

```json
{
  "owner": "cli",
  "repo": "cli",
  "tag": "v2.100.0",
  "previous_tag": "v2.99.0",
  "contact_property": "lifecyclestage",
  "contact_value": "customer",
  "operator_email": "you@example.com"
}
```

The notes are in `outputs.notes.notes_markdown`, the email in `outputs.email`, and the draft id in `outputs.draft.draft_id`. The raw message has moved from `outputs.plan.raw` to `outputs.email.raw`, and there is no longer a report step. A run takes at most 200 recipients; narrow the filter if more contacts match.

The window assumes both releases were tagged on the same line of history and that pull requests are merged, not rebased without a merge record. GitHub allows 30 authenticated search requests a minute, and the pulls step makes one per 100 pull requests.
