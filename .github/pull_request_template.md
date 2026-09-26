## What and why

<!-- What changes, and the problem it solves. Link the issue if there is one. -->

## Checklist

For a new or changed stepfile:

- [ ] Only files in `stepfiles/<id>/` change
- [ ] No `TODO(` markers are left, and `npm run check` passes in `server/`
- [ ] I ran it once against a real model and the real APIs

For a server, format or docs change:

- [ ] `npm run check` passes in `server/`
- [ ] A test fails without this change
- [ ] For a format change: `docs/stepfile.md` and `server/schema/stepfile.schema.json` are updated together
