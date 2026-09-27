# event-weather-contingency

Decides whether an outdoor event goes ahead, goes ahead with a contingency plan, or is postponed, from the Open-Meteo daily forecast for the event's place and date. The thresholds are fixed in the stepfile, so the decision follows mechanically from the forecast values, and gates check each value against the API response and recompute the decision from those values before the plan is written.

## Steps

1. **locate**: finds the place with the Open-Meteo geocoding API. Gates check that the chosen id, name, coordinates, country and region are one geocoding result copied exactly, and that it is in the input country.
2. **forecast**: fetches the daily forecast for the located coordinates on the event date. Gates check that the forecast date is the event date and that all seven values (weather code, maximum and minimum temperature, precipitation total, precipitation probability, wind speed and gusts) come from one successful forecast call made with the located coordinates.
3. **decide**: applies the thresholds below. Gates recompute the decision and the list of triggered rules from the forecast values and fail if the model's answer differs.
4. **plan**: writes a Markdown plan with Decision, Forecast, Thresholds triggered and Plan sections. Gates check the sections are in order, the decision is the one from step 3 and no other is bolded, every forecast value is quoted with its unit, and the backticked rule ids are exactly the triggered rules.

| Rule | Condition | Outcome |
|---|---|---|
| `postpone-thunderstorm` | WMO weather code 95, 96 or 99 | postpone |
| `postpone-gusts` | gusts of 65 km/h or more | postpone |
| `postpone-heavy-rain` | 15 mm of precipitation or more | postpone |
| `postpone-extreme-heat` | maximum of 38 °C or more | postpone |
| `contingency-rain-chance` | precipitation probability of 40 % or more | contingency |
| `contingency-rain` | 2 mm of precipitation or more | contingency |
| `contingency-gusts` | gusts of 40 km/h or more | contingency |
| `contingency-wind` | wind speed of 30 km/h or more | contingency |
| `contingency-heat` | maximum of 32 °C or more | contingency |
| `contingency-cold` | minimum of 5 °C or less | contingency |

Any postpone rule means postpone; otherwise any contingency rule means contingency; otherwise the decision is go.

## Inputs

| Input | Meaning |
|---|---|
| `place` | Town or city name, for example `Edinburgh` |
| `country_code` | ISO 3166-1 alpha-2 code of the place's country, for example `GB`; it picks the right place when several share a name |
| `date` | Event date in the place's local time, as `YYYY-MM-DD`. Open-Meteo accepts dates from today up to 15 days ahead; a later date is rejected and the run stops at the forecast step |

## Credentials

None needed. Both Open-Meteo APIs are free without a key for non-commercial use.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "event-weather-contingency"]
    }
  }
}
```

Then call the `event-weather-contingency` tool with a date within the next seven days, for example `{ "place": "Edinburgh", "country_code": "GB", "date": "2026-09-29" }` when running on 26 September 2026. Replace the date with one close to the day you run it. The plan is in `outputs.plan.markdown`, and the decision with its triggered rules is in `outputs.decide`.

The forecast is daily, so the decision covers the whole day rather than the event's hours.
