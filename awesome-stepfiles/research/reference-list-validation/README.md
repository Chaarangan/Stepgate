# reference-list-validation

Checks a list of references against Crossref and says, for each one, whether it is a real work with the cited DOI, author and year. Every DOI, title, author and year in the result is copied from a Crossref response the run actually received, so a model cannot vouch for a paper that Crossref has never heard of. References that cite a DOI belonging to another paper, or a DOI that does not exist, are flagged with the correct DOI where Crossref has one.

## Steps

1. **parse** (agent): splits each reference into title, first author's family name, year and DOI. Gates check there is one entry per input reference with its text unchanged, ids are unique, and every extracted field appears verbatim in that reference, so nothing is corrected or invented at this stage.
2. **lookup** (mechanical): Stepgate looks up each distinct cited DOI with `lookupDoi` and searches every reference by its title and first author with `searchWorks`, then pairs each reference with its own DOI record and search results, copied from Crossref.
3. **resolve** (agent): picks, for each reference, the Crossref record that is this work, or none. Gates check every reference is answered once and the chosen record is one of that reference's own results. Stepgate then derives the verdict from the choice: `not_found` when nothing matched; `wrong_doi` when a DOI is cited and the matched record is not the one it resolves to; `verified` when the matched year is within one of the cited year and the matched first author's name is inside the reference text; `metadata_mismatch` otherwise.
4. **tally** (mechanical): Stepgate counts each verdict and lists the flagged references with the correct DOI where one matched.
5. **report** (agent): writes a Markdown summary with counts, the flagged references and the verified ones. Gates check the sections are in order, every reference id is mentioned, and every DOI in the text is a cited or matched DOI.

The year tolerance of one allows for a paper published online in one year and in print the next. Title agreement is the model's judgment, since the gates have no fuzzy string comparison, but the matched Crossref title is always shown next to the verdict.

## Inputs

| Input | Meaning |
|---|---|
| `references` | Up to 25 references, one formatted reference per array entry, in any citation style |

## Credentials

None needed. The Crossref REST API is public and takes no key. Its public pool allows about one list request per second, and Stepgate makes calls one at a time and retries a 429 on its own.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "reference-list-validation"]
    }
  }
}
```

Then call the `reference-list-validation` tool with:

```json
{
  "references": [
    "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436-444. https://doi.org/10.1038/nature14539",
    "He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. In Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (pp. 770-778).",
    "Smith, J., & Patel, R. (2021). Neural citation grounding for large language models. Journal of Machine Learning Research, 22(1), 1-30. https://doi.org/10.5555/jmlr.2021.88412",
    "Silver, D., Huang, A., Maddison, C. J., et al. (2016). Mastering the game of Go with deep neural networks and tree search. Nature, 529(7587), 484-489. https://doi.org/10.1038/nature14539"
  ]
}
```

The first two are real and should come back `verified`, the second found by search since it cites no DOI. The third is invented: its DOI does not exist and no search result matches, so it is `not_found`. The fourth is a real paper carrying the first paper's DOI, so it is `wrong_doi` with `10.1038/nature16961` as the correct DOI. The summary is in `outputs.report.summary`, the per-reference verdicts in `outputs.resolve.references`, and the counts and flagged list in `outputs.tally`.

A run makes one lookup per distinct cited DOI and one search per reference, each trimmed to a few fields and at most five results.
