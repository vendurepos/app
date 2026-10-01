# VendurePOS release runbook

**Nothing in this runbook is run until the Front desk says so.** The Vercel tester
deploy was done on 2026-10-01, on the Front desk's ruling; npm publication and
custom-domain DNS remain pending.

## Plugin 0.1.0

1. Paul must `npm login` (password and 2FA) and create the **`@vendurepos` npm
   organisation**. This machine's npm is logged out and the scope does not exist yet.
2. Done in the release PR: `"private": true` removed and `LICENSE` added; the
   version stays `0.1.0`.
3. From `packages/vendure-plugin`, run:

   ```sh
   npm ci
   npm run build
   npm pack --dry-run
   ```

   Review the file list and tarball size: compiled `dist/` JavaScript and
   declarations, the main and `./email` entries, all three migrations, README
   and package metadata. Expect `LICENSE` in the list (npm ships it automatically);
   the changelog stays in the repository.
4. After approval and the release PR merge, publish from that same directory:

   ```sh
   npm publish --access public
   ```

5. Tag the released commit **`plugin-v0.1.0`** and push that tag as part of the
   authorised release. Publish before directing testers to the install command
   in the [quick-start](QUICKSTART.md).

<!-- Sources: packages/vendure-plugin/package.json; packages/vendure-plugin/src/index.ts; docs/PLAN.md (VA8). -->

## Vercel web app

The live tester alias is **`https://vendurepos.vercel.app`**, project `vendurepos`
in Paul's personal Hobby scope (`paul-kilmurrays-projects`), not the WCPOS team.
It can move to WCPOS later with a `vercel project` transfer. There is no custom
domain; `app.vendurepos.com` and its DNS are Paul's, later. Per-deployment URLs
(`vendurepos-<hash>-…vercel.app`) are protected; testers use the alias.

Vercel runs no build and has no `RXDB_PREMIUM` secret. From the repo root, build
a static export locally and upload it as is:

```sh
~/.claude/bin/rxdb-premium-install.sh "$PWD"
env -u RXDB_PREMIUM bash -o pipefail -c 'pnpm --filter @vendurepos/pos build:web 2>&1 | grep -vi accesstoken'
cp apps/pos/vercel.json apps/pos/dist/vercel.json
vercel link --yes --project vendurepos --scope paul-kilmurrays-projects --cwd apps/pos/dist
vercel deploy --prod --yes --scope paul-kilmurrays-projects --cwd apps/pos/dist
```

The install needs the licence; alternatively use an install with its output
filtered through `grep -vi accesstoken`. Keep `RXDB_PREMIUM` unset for the build
so it cannot be inlined. `vercel link` writes `.env.local` (a `VERCEL_OIDC_TOKEN`)
and `.vercel/` in `dist`; Vercel's default ignore list excludes them from the
upload. This was checked on the live alias: `/.env.local` returns the SPA's
`index.html`. Delete `apps/pos/dist/.env.local` after deploying.

`apps/pos/vercel.json` leaves `cleanUrls` disabled. Vercel serves existing files
and rewrites unmatched paths to `/index.html`. Its `/(.*)` header rule applies
the meta CSP plus `frame-ancestors 'none'` to every response, including the SQLite
worker's own response, with `nosniff` and `strict-origin-when-cross-origin`.
The worker needs `'wasm-unsafe-eval'` in that response policy to compile SQLite.
After deploying, verify `/`, a deep link and `/tallyui-sqlite-worker.js` return
200 with the CSP header including `'wasm-unsafe-eval'`; `sqlite3.wasm` must be
served as `application/wasm`. Then follow the [quick-start](QUICKSTART.md)
against a tester's store to a sale.
<!-- Sources: docs/PLAN.md §2 and VA8; apps/pos/vercel.json; apps/pos/public/index.html; apps/pos/scripts/serve-web.ts. -->
