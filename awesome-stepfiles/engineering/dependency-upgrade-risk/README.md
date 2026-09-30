# dependency-upgrade-risk

Takes a list of npm packages with the versions you have pinned, looks up the latest release of each on the npm registry, asks OSV.dev which advisories affect the pinned version and the latest one, and recommends an action per package. Stepgate makes every lookup and applies the rule itself, so no version, advisory id, severity or summary can be misread or invented, and the agent only writes the report, whose gates check it against those results.

## Steps

1. **resolve** (mechanical): Stepgate fetches each pinned version and the `latest` dist-tag from the npm registry. A 404 is an answer here, so the call accepts it: `current_exists` is false when the pinned version is missing, and `latest_version` is null when the package is.
2. **vulns** (mechanical): for every package whose pinned version exists, Stepgate queries OSV once for the pinned version and once for the latest, and keeps each pinned advisory's id, severity (`UNKNOWN` when OSV gives none) and summary, and the ids against the latest release.
3. **recommend** (mechanical): Stepgate applies a fixed rule. The action is `upgrade` when the pinned version has advisories and the latest has none, `review` when the latest release has advisories too, `optional` when the pinned version is clean but not the latest, `keep` when it is clean and current, and `not-found` when the registry does not have it. It also sets the highest severity and the advisory count.
4. **report**: the agent writes a Markdown summary. Gates check that it names every package, names every advisory against a pinned version, and cites no advisory id OSV did not return.

## Inputs

| Input | Meaning |
|---|---|
| `packages` | Up to 10 objects, each with `name` (an npm package name, scoped names such as `@types/node` included) and `version` (an exact version such as `4.17.20`) |

## Credentials

None. The npm registry and OSV.dev are public and need no key.

## Run it

```json
{
  "mcpServers": {
    "stepgate": {
      "command": "npx",
      "args": ["-y", "stepgate", "dependency-upgrade-risk"]
    }
  }
}
```

Then call the `dependency-upgrade-risk` tool with:

```json
{
  "packages": [
    { "name": "lodash", "version": "4.17.20" },
    { "name": "express", "version": "4.17.1" },
    { "name": "minimist", "version": "1.2.5" },
    { "name": "ms", "version": "2.1.3" }
  ]
}
```

In September 2026 this returned five advisories for lodash 4.17.20 (highest HIGH), two for express 4.17.1 and one CRITICAL for minimist 1.2.5, each with a clean latest release, and none for ms 2.1.3, which is its latest version. The recommendations are in `outputs.recommend.packages` and the report in `outputs.report.summary`, which was `outputs.recommend.summary` before the report became its own step.

OSV lists some advisories under both a GitHub id and an alias, so a package can show two ids for one underlying CVE. A run makes two npm requests per package and two OSV requests per package the registry has. The OSV responses carry every advisory in full, which for an old release can run to tens of kilobytes; Stepgate reads them whole, since no model reads them.
