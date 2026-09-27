# sec-10k-ratio-extraction

**This stepfile needs Stepgate started with `--contact <your email>`.** SEC EDGAR refuses requests whose User-Agent carries no contact, and Stepgate adds your email to its User-Agent only when `--contact` is set.

Takes a US-listed ticker, resolves it to the company's SEC CIK, finds its latest annual 10-K, and pulls revenue, net income, operating cash flow, total assets, total liabilities and total equity from the XBRL facts the SEC publishes for that filing. It then computes five ratios and writes a short report. Every figure is checked against the SEC's own response for the exact accession number and period end, and every ratio is recomputed by a gate from those checked figures, so a remembered, rounded or prior-year number fails.

## Steps

1. **resolve**: looks the ticker up in EDGAR company search, confirms the CIK through the SEC submissions record, and finds the newest 10-K in EDGAR filing search. Gates check that the SEC lists the ticker for that CIK, that the CIK, name, tickers and fiscal year end match the submissions record, that the accession number, period end and filing date belong to a 10-K hit for that CIK (not a 10-K/A), and that it is the most recently filed 10-K among the hits.
2. **balance-sheet**: reads Assets, Liabilities and StockholdersEquity (or the version including noncontrolling interest) for that filing. Gates check that each value, with its accession, period end, fiscal year, period and form, is an entry the SEC returned for the concept it is filed under, that all three come from the latest 10-K at its period end rather than a prior-year comparative, and that total liabilities is either the reported Liabilities fact or, only when the SEC has no Liabilities concept for the company, total assets minus total equity.
3. **performance**: reads revenue (the first of three revenue concepts the filing uses), NetIncomeLoss and NetCashProvidedByUsedInOperatingActivities. Gates check each value against the SEC entries for its concept, that all come from the latest 10-K and end at its period end, and that each covers the full fiscal year (11 to 12 months) rather than the fourth quarter.
4. **report**: computes net margin, return on assets, liabilities to assets, liabilities to equity and operating cash flow to net income, and writes a Markdown report with Company, Figures, Ratios and Source sections. Gates check that every ratio equals its formula over the gated figures within 0.0005, that the fiscal year is the SEC's, that the report cites the 10-K accession number and no other, that it states all six figures as plain integers and no other dollar figure, and that every date in it is the period end, filing date or fiscal year start.

## Inputs

| Input | Meaning |
|---|---|
| `ticker` | Ticker in upper case as the SEC lists it, for example `AAPL`, `MSFT` or `BRK-B` |

## Credentials

None. SEC EDGAR needs no key, but it does require a contact email in the User-Agent of every request, so run Stepgate with `--contact you@example.com`. Without it, EDGAR can answer 403 and the run stops with `ToolCallFailed`.

## Run it

```sh
npx -y stepgate --contact you@example.com --tool-result-chars 80000 sec-10k-ratio-extraction
```

Then call the `sec-10k-ratio-extraction` tool with:

```json
{ "ticker": "AAPL" }
```

For Apple this resolves CIK `0000320193` and the 10-K with accession `0000320193-25-000079`, for the fiscal year ending 2025-09-27. The report is in `outputs.report.summary` and the ratios in `outputs.report.ratios`. `{ "ticker": "WMT" }` exercises the derived-liabilities path, because Walmart does not tag a total Liabilities figure.

`--tool-result-chars 80000` matters. The SEC returns every value a company ever filed for a concept, oldest first, so a response runs to 20,000 to 60,000 characters and the latest 10-K's entries sit at the end. At Stepgate's default of 20,000 characters the model sees only older years and cannot find the figures, although the gates still see the whole response and would reject anything it guessed. The submissions record is larger still, but the fields the resolve step needs are at its start.

Report figures are the SEC's XBRL values in US dollars. Total equity excludes noncontrolling interest when the company reports StockholdersEquity; a derived total liabilities figure includes any temporary equity. Banks and insurers use their own revenue concepts and may fail the revenue step.
