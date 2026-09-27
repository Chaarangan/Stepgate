# meeting-scheduler

Finds up to three meeting slots that are free for every attendee inside working hours and drafts the invite email in Gmail. It reads free/busy for all attendees from the Google Calendar API over the date range, has the model pick candidate slots, and then asks Google again about each exact slot, so a slot is accepted only when Google itself reports every attendee free for it. Stepgate builds the raw email from the attendees and the checked subject and body, and stores it as a Gmail draft once a person approves it. It creates no calendar event and never sends.

Status: validated against Google's documentation for the Calendar freeBusy and Gmail drafts.create APIs and offline gate tests (`meeting-scheduler.cases.yaml`), but not yet run live against a Google account.

## Steps

1. **availability** (mechanical): Stepgate makes one freeBusy query for every attendee over the whole date range, from `start_date` 00:00:00 to `end_date` 23:59:59 at the input offset. Gates check the inputs make sense (dates in order, working hours at least as long as the meeting), that Google answered for every attendee, and that no attendee's calendar came back with errors. A calendar Google cannot read (for example `notFound` for someone outside your organisation) stops the run here, so nobody is ever reported free on a calendar that was not seen.
2. **slots**: the agent proposes up to three slots and confirms each with its own freeBusy query whose window is exactly the slot. Stepgate pairs each proposed slot with the successful query for its window and derives `slots`, each with Google's answer as `check`. Gates check that every query covered all attendees, that each slot has such a query and its answer holds an entry for every attendee, that every calendar in it has no busy time and no errors, that every slot carries the input UTC offset, lies on one date within the range, starts and ends inside working hours and lasts exactly the requested duration, and that no two slots start together.
3. **invite**: the agent writes the subject and body. Stepgate sets `to` to the attendees and builds `raw`, the RFC 2822 message: `To` (the attendees joined by `, `), `Subject`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8` and `Content-Transfer-Encoding: 8bit`, an empty line, then the body, every line ending in CRLF. The subject must be one line, so no header can be added through it. Gates check the subject contains the title and the body states the duration and lists every confirmed slot as `YYYY-MM-DD HH:MM to HH:MM (UTC+hh:mm)`, with no other time in that form. Then a person is asked to approve the draft: the message shows the whole output, including `raw`, the exact message Gmail will store.
4. **draft** (mechanical): Stepgate calls `createDraft`, Gmail's `drafts.create` media upload, with the approved `raw`, and records the draft's `id` and `message.id`.

The approval in step 3 needs an MCP client that supports form elicitation; on one that does not, the run fails before its first step.

Busy time is checked by Google rather than by comparing timestamps in the stepfile. A freeBusy query over exactly the slot's window answers the overlap question directly: every calendar must come back with an empty busy list. Google keys the results by calendar id, an email address, and the gates compare each answer's keys with the attendee list to make sure none is missing. Working hours and the date range are checked mechanically on the slot's local time, which is why slots are written with the input offset.

## Inputs

| Input | Meaning |
|---|---|
| `attendees` | Attendee email addresses, lowercase, up to 20. Each is queried as a Google calendar id, so you need at least free/busy visibility of each person's calendar |
| `title` | What the meeting is about, used in the subject |
| `duration_minutes` | Meeting length, 15 to 480, in steps of 5 |
| `start_date`, `end_date` | First and last date a meeting may fall on, `YYYY-MM-DD`, inclusive, in the working-hours time zone |
| `work_start`, `work_end` | Working hours as `HH:MM` local time; a meeting must start at or after the first and end at or before the second |
| `utc_offset` | The UTC offset of those working hours, such as `+01:00` or `-05:00` |

The offset applies to the whole range. If a daylight saving change falls inside it, split the range at the change. Weekends are not excluded, so choose a range of working days. Slots never cross midnight.

## Credentials

| Credential | Variable | Value | Minimum scope |
|---|---|---|---|
| `google-calendar` | `GOOGLE_CALENDAR_API_KEY` | A Google OAuth 2.0 access token, sent as `Authorization: Bearer <token>` | `https://www.googleapis.com/auth/calendar.events.freebusy` ("See the availability on Google calendars you have access to") |
| `gmail` | `GMAIL_API_KEY` | A Google OAuth 2.0 access token for the mailbox that should hold the draft, sent as `Authorization: Bearer <token>` | `https://www.googleapis.com/auth/gmail.compose` |

Google access tokens expire after about an hour, and Stepgate does not refresh them, so fetch fresh tokens before each run. One token carrying both scopes can be supplied as both variables. The narrower `calendar.freebusy` scope only covers your own calendars, which is not enough to query other attendees.

## Writes

One Gmail draft of the invite, never sent, created only after you approve it in step 3. The draft step posts the approved raw message to `https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media` with `Content-Type: message/rfc822`, so nothing is base64-encoded. The stepfile exposes no send operation and creates no calendar event. The freeBusy query is sent as a POST but only reads, as Google documents, so the stepfile declares it `effect: read`.

The message has no `From` header. The Gmail API pages this was checked against do not say whether a draft needs one or what Gmail fills in (their examples set one), so check the sender when you open the draft. A meeting title with non-ASCII characters is sent in the subject as UTF-8 rather than RFC 2047 encoded words, which has not been tried against Gmail.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "meeting-scheduler"],
      "env": { "GOOGLE_CALENDAR_API_KEY": "ya29....", "GMAIL_API_KEY": "ya29...." }
    }
  }
}
```

Then call the `meeting-scheduler` tool with:

```json
{
  "attendees": ["alice@example.com", "bob@example.com"],
  "title": "Q4 planning",
  "duration_minutes": 30,
  "start_date": "2026-10-06",
  "end_date": "2026-10-08",
  "work_start": "09:00",
  "work_end": "17:00",
  "utc_offset": "+01:00"
}
```

using attendees whose calendars your account can see and dates in the near future. The email is in `outputs.invite` (`to`, `subject`, `body`, `raw`), the draft id in `outputs.draft.draft_id`, and the confirmed slots in `outputs.slots.slots`. The raw message has moved from `outputs.plan.raw` to `outputs.invite.raw`, and there is no longer a report step. If no slot in the range is free for everyone, the run stops at the slots step.
