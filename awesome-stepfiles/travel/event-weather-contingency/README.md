# event-weather-contingency

Decides whether an outdoor event goes ahead, goes ahead with a contingency plan, or is postponed, from the Open-Meteo daily forecast for the event's place and date. The thresholds are fixed in the stepfile, so Stepgate locates the place, fetches the forecast and applies the thresholds itself; the agent writes only the plan, and gates check it quotes the forecast and the decision it rests on.

## Steps

1. **locate** (mechanical): Stepgate searches the Open-Meteo geocoding API for the place within the input country and takes the first match, keeping its id, name, coordinates, country and region. A gate stops the run if that match is not in the input country.
2. **forecast** (mechanical): Stepgate fetches the daily forecast for the located coordinates on the event date and keeps the seven values (weather code, maximum and minimum temperature, precipitation total, precipitation probability, wind speed and gusts). A gate stops the run if the forecast is for another date.
3. **decide** (mechanical): Stepgate applies the thresholds below and lists the triggered rules and the decision.
4. **plan**: the agent writes a Markdown plan with Decision, Forecast, Thresholds triggered and Plan sections; Stepgate copies the decision from step 3 into the output. Gates check the sections are in order, that the decision from step 3 is bolded and no other is, that every forecast value is quoted with its unit, and that the backticked rule ids are exactly the triggered rules.

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
| `date` | Event date in the place's local time, as `YYYY-MM-DD`. Open-Meteo accepts dates from today up to 15 days ahead; a later date is rejected and the run stops at step 2 |

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

Then call the `event-weather-contingency` tool with a date within the next seven days, for example `{ "place": "Edinburgh", "country_code": "GB", "date": "2026-09-29" }` when running on 26 September 2026. Replace the date with one close to the day you run it. The plan is in `outputs.plan.markdown`, and the decision with its triggered rules is in `outputs.decide`; the reasoning in words is in the plan.

The forecast is daily, so the decision covers the whole day rather than the event's hours.
