# meeting-scheduler

Finds up to three meeting slots that are free for every attendee inside working hours and drafts the invite email in Gmail. It reads free/busy for all attendees from the Google Calendar API over the date range, has the model pick candidate slots, and then asks Google again about each exact slot, so a slot is accepted only when Google itself reports every attendee free for it. The invite is then written as a raw email and stored as a Gmail draft, checked byte for byte against the gated recipients, subject and body. It creates no calendar event and never sends.

Status: validated against Google's documentation for the Calendar freeBusy and Gmail drafts.create APIs and offline gate tests, but not yet run live against a Google account.

## Steps

1. **availability**: makes one freeBusy query for every attendee over the whole date range and copies the returned `calendars` object into the output. Gates check the inputs make sense (dates in order, working hours at least as long as the meeting), that the query used the exact window, time zone UTC and every attendee in input order, that the copied object is exactly what that query returned, that the object holds an entry for every attendee (looked up by email address with `get`), and that no attendee's calendar came back with errors. A calendar Google cannot read (for example `notFound` for someone outside your organisation) stops the run here, so nobody is ever reported free on a calendar that was not seen.
2. **slots**: picks up to three slots and confirms each with its own freeBusy query whose window is exactly the slot. Gates check that every query covered all attendees, that each slot's evidence is the response of the query for exactly that slot and holds an entry for every attendee, that every calendar in that response has no busy time and no errors, that every slot carries the input UTC offset, lies on one date within the range, starts and ends inside working hours and lasts exactly the requested duration, and that no two slots start together.
3. **invite**: writes the email. Gates check the recipients are exactly the attendees, the subject contains the title, the body states the duration and lists every confirmed slot as `YYYY-MM-DD HH:MM to HH:MM (UTC+hh:mm)`, with no other time in that form.
4. **plan**: writes the raw RFC 2822 message: `To` (the recipients joined by `, `), `Subject`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8` and `Content-Transfer-Encoding: 8bit`, an empty line, then the body, every line ending in CRLF. Gates check the message is exactly that, built from the checked invite; that the header block is exactly those five lines, so no `Cc`, `Bcc` or other header can be added; and that the `To` and `Subject` headers equal the checked values and hold no line break.
5. **draft**: calls `createDraft`, Gmail's `drafts.create` media upload. Gates check there was exactly one call, it succeeded, its body is the planned message byte for byte, and the draft id and message id submitted are the `id` and `message.id` of the Draft Gmail returned.
6. **report**: states the draft id. Gates check the ids are the created draft's and the summary cites the draft id.

Busy time is checked by Google rather than by comparing timestamps in the stepfile. A freeBusy query over exactly the slot's window answers the overlap question directly: every calendar must come back with an empty busy list. Google keys the results by calendar id, an email address, and the gates read each attendee's entry with the `get` operator to make sure none is missing. Working hours and the date range are checked mechanically on the slot's local time, which is why slots are written with the input offset.

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

One Gmail draft of the invite, never sent. The draft step posts the raw message to `https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media` with `Content-Type: message/rfc822`, so the model writes plain text and nothing is base64-encoded. The stepfile exposes no send operation and creates no calendar event.

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

using attendees whose calendars your account can see and dates in the near future. The email is in `outputs.invite` (`to`, `subject`, `body`), the raw message in `outputs.plan.raw`, the draft id in `outputs.draft.draft_id`, and the confirmed slots in `outputs.slots.slots`. If no slot in the range is free for everyone, the run stops at the slots step.
