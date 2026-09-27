# github-release-to-customers

Takes a GitHub release tag and the tag before it, collects the pull requests merged between the two, writes customer-facing release notes that cite each change by pull request number, finds the HubSpot contacts matching a property filter, and creates a Gmail draft addressed to you with the notes and the recipient list. Every pull request number, title and merge time is checked against GitHub, every contact id and email against HubSpot, the email's recipients against the contacts found, and the draft Gmail stores against the checked email. It creates a draft and never sends (see [Writes](#writes)).

Status: validated against the vendors' documented APIs (GitHub REST API version 2026-03-10, HubSpot CRM objects API version 2026-09, Gmail API v1) and offline gate tests built from real GitHub responses and HubSpot's and Google's documented examples, but not yet run live against a HubSpot account or a Gmail mailbox.

## Steps

1. **releases**: fetches both releases with `getReleaseByTag`. Gates check that the name, URL and `created_at` of each are copied from the response for that tag in this repository, that the previous release is older, and that the merge window runs from the previous release's `created_at` plus 2 seconds to the new one's plus 1 second. GitHub documents `created_at` as the date of the release's commit, and records a pull request's merge about a second after its merge commit, so this window keeps the previous release's own pull request out and the new release's in. On `cli/cli` v2.99.0 to v2.100.0 it gives exactly the 12 pull requests GitHub's own release notes list.
2. **pulls**: searches merged pull requests in that window. Gates check every search used the exact query, every result belongs to this repository, each number, title and merge time is copied from a result, the list matches the search's `total_count` with nothing repeated, and every merge falls inside the window.
3. **notes**: sorts each pull request into customer-facing items or excluded internal work and writes the notes. Gates check every pull request is sorted exactly once, item titles are GitHub's, and the notes mention the tag, cite every item as `#number` and cite no excluded or unknown number.
4. **audience**: searches HubSpot contacts with one `EQ` filter, 50 a page, following `paging.next.after`. Gates check every call used exactly the given property and value, every contact's id, email and names are copied from a result (emails compared case-insensitively), contacts without an email are listed separately, and the two lists together match the search's `total`.
5. **email**: prepares the email. Gates check it is addressed to `operator_email`, its recipients are exactly the contacts' addresses, its subject and body name the tag, and its body cites every note item, no other pull request number, and lists every recipient.
6. **plan**: writes the raw RFC 2822 message: `To`, `Subject`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8` and `Content-Transfer-Encoding: 8bit`, an empty line, then the body, every line ending in CRLF. Gates check the message is exactly that, built from the checked `to`, `subject` and `body`; that the header block is exactly those five lines, so no `Cc`, `Bcc` or other header can be added; and that the `To` and `Subject` headers equal the checked values and hold no line break.
7. **draft**: calls `createDraft`, Gmail's `drafts.create` media upload. Gates check there was exactly one call, it succeeded, its body is the planned message byte for byte, and the draft id and message id submitted are the `id` and `message.id` of the Draft Gmail returned.
8. **report**: states the draft id. Gates check the ids are the created draft's and the summary cites the draft id.

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

One Gmail draft, never sent. The draft step posts the raw message to `https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media` with `Content-Type: message/rfc822`, so the model writes plain text and nothing is base64-encoded. The stepfile exposes no send operation. The draft is addressed to `operator_email` only; the customer addresses are listed in its body for you to review and send from your mail client.

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

The notes are in `outputs.notes.notes_markdown`, the email in `outputs.email`, the raw message in `outputs.plan.raw` and the draft id in `outputs.draft.draft_id`. A run takes at most 200 recipients; narrow the filter if more contacts match.

The window assumes both releases were tagged on the same line of history and that pull requests are merged, not rebased without a merge record. GitHub's search items carry each pull request's full description, so the model is told to page three at a time and to fetch an item alone when a page is cut off at `--tool-result-chars`; a release with many pull requests means many search calls, and GitHub allows 30 authenticated search requests a minute.
