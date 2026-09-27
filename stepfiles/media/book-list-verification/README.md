# book-list-verification

Checks a reading list against Open Library and says, for each book, whether it exists under the author the list names. In May 2025 a syndicated summer reading list printed in the Chicago Sun-Times and The Philadelphia Inquirer recommended books that do not exist, such as "Tidewater Dreams" credited to Isabel Allende; this stepfile catches that kind of list before it is published. Every work key, title and author name in the result is copied from an Open Library response the run actually received, and a book counts as confirmed only when Open Library returns it for a search filtered by the stated author.

## Steps

1. **search**: searches Open Library once per book with `searchByTitleAndAuthor`, using the title and author exactly as given, and picks the result that is this book, if any. Gates check every book is searched once with its exact title and author, the recorded results are exactly what that search returned, and the chosen match is one of that book's own results.
2. **crosscheck**: for every book with no match, searches by title alone with `searchByTitle` to learn whether it exists under someone else's name. Gates check exactly the unmatched books are checked, their results are exactly what the title search returned, and any book found is one of those results and does not list the stated author.
3. **publish**: gives each book a verdict of `verified`, `wrong_author` or `not_found`, lists the confirmed books, and writes a Markdown summary. Gates check each verdict follows from the two earlier steps (a match means verified, a title-only find means wrong author, neither means not found), the confirmed list holds only verified books, the counts agree, every book id is mentioned, and every work key in the summary is one from the verdicts.

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

The first two are real and should come back `verified`. "The Last Algorithm" and "Tidewater Dreams" are invented titles from the 2025 list; neither search finds them, so both are `not_found`. "The Road" is real but misattributed: the author search returns only other Stephen King books, and the title search finds it under Cormac McCarthy, so it is `wrong_author`. The summary is in `outputs.publish.summary` and the confirmed books in `outputs.publish.confirmed`.

Each search asks for at most five results with four fields, so a thirty-book list stays small in a model's context.
