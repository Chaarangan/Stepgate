# auto-claim-vin-validation

Checks the vehicle on an auto insurance claim against its VIN. It decodes the VIN with NHTSA's vPIC service, compares the claimed make, model and model year with the decode, lists the NHTSA safety recalls for the decoded vehicle, and returns a verdict of `consistent` or `refer` with the reasons. A model left to itself tends to accept the claimant's description of the vehicle. Here Stepgate makes the lookups and the comparison itself, so no decoded value, match or recall can be misread or invented, and the agent only writes the summary, whose gates check it against those values.

## Steps

1. **decode** (mechanical): Stepgate calls vPIC for the claim's VIN and keeps the make, model, year, body class, error code and error text. A gate stops the run if the VIN decodes to no make, model and four-digit year.
2. **compare** (mechanical): Stepgate compares each claimed field with the decode, make and model ignoring letter case, and sets `any_mismatch`.
3. **recalls** (mechanical): Stepgate calls NHTSA's recalls API for the decoded make, model and year and keeps the count and every recall's campaign number, component and date. NHTSA answers 400 with a count of 0 when there are none, which the call accepts.
4. **verdict** (mechanical): Stepgate lists the reasons (a vPIC error code other than `0`, and each mismatched field) and returns `consistent` only when there are none.
5. **report**: the agent writes a Markdown summary for a claims handler. Gates check that it names the VIN, the decoded vehicle and the verdict, and cites only campaign numbers step 3 listed.

## Inputs

| Input | Meaning |
|---|---|
| `vin` | The 17-character VIN on the claim, in capitals, for example `JTDKB20U693456789` |
| `claimed_make` | The make the claimant gave, for example `Toyota` |
| `claimed_model` | The model the claimant gave, for example `Prius` |
| `claimed_year` | The model year the claimant gave, for example `2009` |

## Credentials

None needed. Both vPIC and the NHTSA recalls API answer without a key.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "auto-claim-vin-validation"]
    }
  }
}
```

Then call the `auto-claim-vin-validation` tool with `{ "vin": "JTDKB20U693456789", "claimed_make": "Toyota", "claimed_model": "Camry", "claimed_year": 2010 }`. On 26 September 2026 that VIN decoded clean to a 2009 TOYOTA Prius with six NHTSA recalls, so the run returns `refer` with `model_mismatch` and `model_year_mismatch`. Claiming `Prius` and `2009` instead returns `consistent`. The verdict is in `outputs.verdict.verdict` and the summary in `outputs.report.summary_markdown`.

The recalls API has no page size, so a vehicle with many recalls returns a long response; Stepgate reads it whole, since no model reads it. The API matches on NHTSA's own model names, which sometimes differ from vPIC's (a 2008 Mercedes-Benz `E-Class` decodes but its recalls are filed under `E350`), so a count of 0 means no recalls under the decoded name, not proof that none exist. NHTSA complaints are left out because one model year can return over 2 MB with no way to limit it.
