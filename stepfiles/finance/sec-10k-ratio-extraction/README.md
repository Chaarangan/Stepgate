# sec-10k-ratio-extraction

**This stepfile needs Stepgate started with `--contact <your email>`.** SEC EDGAR refuses requests whose User-Agent carries no contact, and Stepgate adds your email to its User-Agent only when `--contact` is set.

Takes a US-listed ticker, resolves it to the company's SEC CIK, finds its latest annual 10-K, and pulls revenue, net income, operating cash flow, total assets, total liabilities and total equity from the XBRL facts the SEC publishes for that filing. It then computes five ratios and writes a short report. Stepgate makes every lookup, picks every figure by the filing's accession number and period end, and computes the ratios itself, so a remembered, rounded or prior-year number cannot reach the report, and the agent only writes the report, whose gates check it against those figures.

## Steps

1. **resolve** (mechanical): Stepgate looks the ticker up in EDGAR company search, takes the first hit's CIK, reads the SEC submissions record for the name, tickers and fiscal year end, and takes the most recently filed 10-K (not a 10-K/A) from EDGAR filing search. A gate stops the run if the SEC does not list the ticker for that CIK.
2. **balance-sheet** (mechanical): Stepgate reads Assets, Liabilities and StockholdersEquity (or, when that has no value for the filing, the version including noncontrolling interest) and keeps the entry of each at the latest 10-K's accession and period end. The Liabilities call accepts a 404, since some companies never tag it; a gate stops the run if the company tags Liabilities but not for this filing.
3. **performance** (mechanical): Stepgate reads revenue (the first of three revenue concepts with a value for the filing), NetIncomeLoss and NetCashProvidedByUsedInOperatingActivities, and keeps the entry of each at the filing's accession and period end that covers 11 to 12 months, so the full fiscal year rather than the fourth quarter.
4. **ratios** (mechanical): Stepgate sets total liabilities to the reported Liabilities fact, or to total assets minus total equity when the SEC has no Liabilities concept for the company, and computes net margin, return on assets, liabilities to assets, liabilities to equity and operating cash flow to net income.
5. **report**: the agent writes a Markdown report with Company, Figures, Ratios and Source sections. Gates check that it cites the 10-K accession number and no other, names the company, states all six figures as plain integers and no other dollar figure, and that every date in it is the period end, filing date or fiscal year start.

## Inputs

| Input | Meaning |
|---|---|
| `ticker` | Ticker in upper case as the SEC lists it, for example `AAPL`, `MSFT` or `BRK-B` |

## Credentials

None. SEC EDGAR needs no key, but it does require a contact email in the User-Agent of every request, so run Stepgate with `--contact you@example.com`. Without it, EDGAR can answer 403 and the run stops with `ToolCallFailed`.

## Run it

```sh
npx -y stepgate --contact you@example.com sec-10k-ratio-extraction
```

Then call the `sec-10k-ratio-extraction` tool with:

```json
{ "ticker": "AAPL" }
```

For Apple this resolves CIK `0000320193` and the 10-K with accession `0000320193-25-000079`, for the fiscal year ending 2025-09-27. The report is in `outputs.report.summary` and the ratios in `outputs.ratios.ratios`, with the fiscal year and total liabilities beside them; the ratios and fiscal year were in `outputs.report` before Stepgate computed them. `{ "ticker": "WMT" }` exercises the derived-liabilities path, because Walmart does not tag a total Liabilities figure.

The SEC returns every value a company ever filed for a concept, oldest first, so a response runs to 20,000 to 60,000 characters. Stepgate reads it whole, since no model reads it, so `--tool-result-chars` no longer matters for this entry.

Report figures are the SEC's XBRL values in US dollars. Total equity excludes noncontrolling interest when the company reports StockholdersEquity; a derived total liabilities figure includes any temporary equity. Banks and insurers use their own revenue concepts and may fail the revenue step.
