# auto-claim-vin-validation

Checks the vehicle on an auto insurance claim against its VIN. It decodes the VIN with NHTSA's vPIC service, compares the claimed make, model and model year with the decode, lists the NHTSA safety recalls for the decoded vehicle, and returns a verdict of `consistent` or `refer` with the reasons. A model left to itself tends to accept the claimant's description of the vehicle; here the decoded values, the comparison, the recall count and every cited campaign number are checked mechanically against the API responses and the claim's own inputs.

## Steps

1. **decode**: calls vPIC once for the claim's VIN. Gates check that the vehicle decoded to a make, model and four-digit year, and that the VIN, make, model, year, body class, error code and error text are copied exactly from the response for that VIN.
2. **compare**: compares each claimed field with the decode. Gates check that the claimed and decoded values are the inputs and step 1's output unchanged, that `match` is true exactly when make or model are equal ignoring letter case (computed in the gate by lowercasing both strings character by character), that the years are equal, and that `any_mismatch` follows.
3. **recalls**: calls NHTSA's recalls API for the decoded make, model and year. Gates check that every call used exactly the decoded vehicle, that `recall_count` is the `Count` NHTSA returned (or 0 where it answered with `Count` 0), that every listed recall's campaign number, component and date match the response, and that at least the first ten recalls, or all of them if fewer, are listed once each.
4. **report**: returns the verdict, the reasons and a Markdown summary for a claims handler. Gates check that the reasons are exactly the VIN decode error (vPIC error code other than `0`) and the mismatched fields, that the verdict is `consistent` only when there are none, that the recall count is carried over, that the summary names the VIN and the decoded vehicle, and that every campaign number it cites was listed in step 3.

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

Then call the `auto-claim-vin-validation` tool with `{ "vin": "JTDKB20U693456789", "claimed_make": "Toyota", "claimed_model": "Camry", "claimed_year": 2010 }`. On 26 September 2026 that VIN decoded clean to a 2009 TOYOTA Prius with six NHTSA recalls, so the run returns `refer` with `model_mismatch` and `model_year_mismatch`. Claiming `Prius` and `2009` instead returns `consistent`. The verdict is in `outputs.report.verdict` and the summary in `outputs.report.summary_markdown`.

The recalls API has no page size, so a vehicle with many recalls returns a long response. Stepgate passes the model the first 20,000 characters (about a dozen recalls), which is why step 3 asks for the first ten rather than all of them; the count is always the full total. The API matches on NHTSA's own model names, which sometimes differ from vPIC's (a 2008 Mercedes-Benz `E-Class` decodes but its recalls are filed under `E350`), so a count of 0 means no recalls under the decoded name, not proof that none exist. NHTSA complaints are left out because one model year can return over 2 MB with no way to limit it.
