# Stepfile catalog

Community stepfiles, reviewed and shipped with Stepgate. Each folder here is one stepfile you can run by name:

```sh
npx -y stepgate --list            # what's in the catalog
npx -y stepgate market-research   # serve one over stdio
```

Every folder has a README with what the stepfile does, its inputs, and the credentials it needs.

## Add yours

A stepfile is worth sharing when it turns a task people repeat into steps with real checks. You need Node.js 22.18 or later.

1. Fork the repository, then run `npm run new-stepfile -- <id>` in `server/`. It creates `stepfiles/<id>/` with a working stepfile and a README.
2. Write the procedure. [docs/stepfile.md](../docs/stepfile.md) explains every field, and [market-research](market-research/) is a complete example.
3. Replace every `TODO(<id>)` marker, then run `npm run check` in `server/`.
4. Run it once against a real model and API, and open a pull request that changes only your folder.

A catalog entry must:

- live in `stepfiles/<id>/`, as `<id>.stepfile.yaml` plus a `README.md`, with the folder name equal to the stepfile's `id`;
- call only public `https` APIs and MCP servers, and declare every credential with a clear `description`;
- give every step gates that check real properties of the output, not just its shape;
- contain no secrets, personal data, or anything tied to one model or provider.

`npm run check` enforces the structural rules, and CI runs it on every pull request. Not sure what to build? [Suggest an idea](https://github.com/Chaarangan/stepgate/issues/new?template=stepfile_idea.yml), or pick one someone else suggested.
