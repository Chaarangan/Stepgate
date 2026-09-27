# Stepfile catalog

Community stepfiles, reviewed and shipped with Stepgate, grouped into domain folders such as `marketing/`. Each entry runs by name:

```sh
npx -y stepgate --list            # the catalog, by domain
npx -y stepgate market-research   # serve one over stdio
```

Every folder has a README with what the stepfile does, its inputs, and the credentials it needs.

A stepfile does not need to be here to run: pass the path of your own file to `stepgate` instead of a catalog name, as [docs/connect.md](../docs/connect.md#your-own-stepfiles) describes. The catalog is for stepfiles worth sharing.

## Add yours

A stepfile is worth sharing when it turns a task people repeat into steps with real checks. You need Node.js 22.18 or later.

1. Fork the repository, then run `npm run new-stepfile -- <domain>/<id>` in `server/`, choosing an existing domain folder where one fits. It creates `stepfiles/<domain>/<id>/` with a working stepfile and a README.
2. Write the procedure. [docs/stepfile.md](../docs/stepfile.md) explains every field, and [marketing/market-research](marketing/market-research/) is a complete example.
3. Replace every `TODO(<id>)` marker, and add `<id>.cases.yaml` with recorded calls and outputs, so `stepgate --test <id>` and CI check your gates offline ([docs/stepfile.md](../docs/stepfile.md#testing-gates-offline)). Running Stepgate with `--record-cases <dir>` writes one from a real run; trim it and remove anything personal. Then run `npm run check` in `server/`.
4. Run it once against a real model and API, and open a pull request that changes only your folder.

A catalog entry must:

- live in `stepfiles/<domain>/<id>/`, as `<id>.stepfile.yaml`, a `README.md` and an `<id>.cases.yaml`, with the folder name equal to the stepfile's `id`, and an `id` no other domain uses;
- call only public `https` APIs and MCP servers, and declare every credential with a clear `description`;
- give every step gates that check real properties of the output, not just its shape;
- write only from a mechanical step, after an agent step with an `approve` gate, using only inputs, settings and earlier steps' outputs, so what reaches an API is what a person approved. An operation counts as a write unless it is an OpenAPI GET, HEAD or OPTIONS, or its `exposes` entry declares `effect: read`; declare that only where the API's documentation says the operation changes nothing;
- contain no secrets, personal data, or anything tied to one model or provider.

`npm run check` enforces the structural rules, and CI runs it on every pull request. Not sure what to build? [Suggest an idea](https://github.com/Chaarangan/stepgate/issues/new?template=stepfile_idea.yml), or pick one someone else suggested.
