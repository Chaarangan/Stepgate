# book-list-verification

Checks a reading list against Open Library and says, for each book, whether it exists under the author the list names. In May 2025 a syndicated summer reading list printed in the Chicago Sun-Times and The Philadelphia Inquirer recommended books that do not exist, such as "Tidewater Dreams" credited to Isabel Allende; this stepfile catches that kind of list before it is published. Every work key, title and author name in the result is copied from an Open Library response the run actually received, and a book counts as confirmed only when Open Library returns it for a search filtered by the stated author.

## Steps

1. **search** (agent): searches Open Library once per book with `searchByTitleAndAuthor`, using the title and author exactly as given, and picks the result that is this book, if any. Gates check every book is submitted once with its title and author unchanged, each has a successful search with its exact title and author, and the chosen match is one of that search's own results, copied exactly.
2. **crosscheck** (agent): for every book with no match, searches by title alone with `searchByTitle` to learn whether it exists under someone else's name. Gates check exactly the unmatched books are checked, each has a successful title search, and any book found is one of that search's results and does not list the stated author.
3. **classify** (mechanical): Stepgate gives each book a verdict of `verified` (a match), `wrong_author` (no match, but a title-only find) or `not_found` (neither), copies the work key and Open Library authors from that doc, lists the confirmed books and counts each verdict.
4. **publish** (agent): writes a Markdown summary from the verdicts. Gates check the two sections are in order, every book id is mentioned, and every work key in the summary is one from the verdicts.

The searches stay agent steps although the inputs fix them: a mechanical step's output cannot tell which book each Open Library response belongs to, since the responses do not echo the query.

Whether a search result is the same book as the list entry (allowing for case, punctuation and subtitles) is the model's judgment, since the gates have no fuzzy string comparison. The Open Library title and authors are always shown beside the verdict so a reader can see what was matched. Publication years are not checked, because Open Library's `first_publish_year` is unreliable for older books.

## Inputs

| Input | Meaning |
|---|---|
| `books` | Up to 30 books, each `{ "title": ..., "author": ... }` as the list states them |

## Credentials

None needed. The Open Library search API is public and takes no key.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "book-list-verification"]
    }
  }
}
```

Then call the `book-list-verification` tool with:

```json
{
  "books": [
    { "title": "Klara and the Sun", "author": "Kazuo Ishiguro" },
    { "title": "Beach Read", "author": "Emily Henry" },
    { "title": "The Last Algorithm", "author": "Andy Weir" },
    { "title": "Tidewater Dreams", "author": "Isabel Allende" },
    { "title": "The Road", "author": "Stephen King" }
  ]
}
```

The first two are real and should come back `verified`. "The Last Algorithm" and "Tidewater Dreams" are invented titles from the 2025 list; neither search finds them, so both are `not_found`. "The Road" is real but misattributed: the author search returns only other Stephen King books, and the title search finds it under Cormac McCarthy, so it is `wrong_author`. The summary is in `outputs.publish.summary`; the verdicts, confirmed books and counts are in `outputs.classify`.

Each search asks for at most five results with four fields, so a thirty-book list stays small in a model's context.
