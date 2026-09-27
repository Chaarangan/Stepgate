# dependency-upgrade-risk

Takes a list of npm packages with the versions you have pinned, looks up the latest release of each on the npm registry, asks OSV.dev which advisories affect the pinned version and the latest one, and recommends an action per package. Every version, advisory id, severity and summary in the result is checked against the API response it came from, so a version that does not exist or an advisory nobody published cannot reach the report.

## Steps

1. **resolve**: fetches each pinned version and the `latest` dist-tag from the npm registry. Gates check there is one row per input package with the version as given, that `current_exists` is true only where the registry returned that exact version and false only where it returned 404, and that `latest_version` is the version the `latest` call returned.
2. **vulns**: queries OSV once per version, for the pinned version and for the latest one when they differ. Gates check every package that exists is covered, that every version listed was actually queried, that every advisory id is one OSV returned for that package and version, that no id is repeated, and that no id OSV returned was dropped.
3. **details**: fetches each advisory against a pinned version from OSV. Gates check every advisory from the previous step appears exactly once under its own package, and that each severity and summary is copied from the advisory record.
4. **recommend**: applies a fixed rule and writes a Markdown summary. The action is `upgrade` when the pinned version has advisories and the latest has none, `review` when the latest release has advisories too (or there is none), `optional` when the pinned version is clean but not the latest, `keep` when it is clean and current, and `not-found` when the registry does not have it. Gates check the versions match step 1, the action follows the rule, the highest severity and advisory count match step 3, and the summary names every package.

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

In September 2026 this returned five advisories for lodash 4.17.20 (highest HIGH), two for express 4.17.1 and one CRITICAL for minimist 1.2.5, each with a clean latest release, and none for ms 2.1.3, which is its latest version. The recommendations are in `outputs.recommend.packages` and the report in `outputs.recommend.summary`.

OSV lists some advisories under both a GitHub id and an alias, so a package can show two ids for one underlying CVE. The details step makes one call per advisory, so a very old release with dozens of advisories takes many tool calls in one step; if a run hits `--calls-per-step`, check fewer packages at a time.
