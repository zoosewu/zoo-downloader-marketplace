# Zoo Downloader marketplace: zoo

The site modules [Zoo Downloader](https://github.com/zoosewu/zoo-downloader) comes with: the
marketplace named "zoo" (modules install as `<id>@zoo`; it was called "official" until app
0.5.0, which moves modules installed under that name). The app reads `zoo-marketplace.json`
from this repository's default branch, so a
module change pushed to `main` reaches every user (who checks for module updates) without an
app release.

## Layout

- `zoo-marketplace.json`: the catalog. `version`, `apiVersion` and `sha256` are generated
  (`pnpm catalog`); write `description` and the order by hand.
- `<id>/`: one module project each (`src/` → `dist/index.js`, `manifest.json`, `tests/`,
  `types/` = the SDK). Its `AGENTS.md` explains how to work on it.
- `sdk.json`: the Zoo Downloader commit whose SDK every module's `types/` is.

## Changing a module

```sh
pnpm install
# edit <id>/src/index.ts, raise "version" in <id>/manifest.json
pnpm build && pnpm catalog
pnpm check
zoo-module test            # in <id>/: replays tests/cassettes (zoo-module-<platform> is on every app release)
```

Push to `main` to publish. To try a change first, push a branch and add its catalog as a
marketplace in the app: `https://raw.githubusercontent.com/zoosewu/zoo-downloader-marketplace/<branch>/zoo-marketplace.json`.

## API level

A module's `apiVersion` is the API level of the SDK it is written against; an app shows a module
on a newer level than it runs as needing a newer Zoo Downloader, and keeps the installed version.
To use a newer level: `pnpm sdk <zoo-downloader commit or tag>`, then raise `apiVersion` in the
modules that use it. See the app's `docs/architecture/module-versions.md`.

Never commit `.credentials.json` (your own accounts for recording tests).

## License

The code is licensed under the [GNU AGPL-3.0](LICENSE).

## Contributing

Pull requests need the [Contributor License Agreement](CLA.md) signed once: the CLA check comments on
your first pull request and tells you how.
