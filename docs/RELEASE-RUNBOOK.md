# VendurePOS release runbook

**Nothing in this runbook is run until the Front desk says so.** The Vercel tester
deploy was done on 2026-10-01, on the Front desk's ruling; custom-domain DNS remains pending;
npm publication of the plugin follows the section below.

## Plugin releases

1. **0.1.0 (manual, once).** On `main`, an npm owner of the `vendurepos` org
   publishes by hand from `packages/vendure-plugin`:

   ```sh
   npm ci
   npm run build
   npm pack --dry-run
   ```

   Review the file list: `dist/`, `LICENSE`, `README.md`, `package.json`, nothing else.
   Then publish; npm asks for a 2FA one-time password (`--otp=<code>`), so this is Paul's:

   ```sh
   npm publish --access public
   ```

   Tag that commit `plugin-v0.1.0` and push the tag. The release workflow sees
   0.1.0 already on npm and exits green without publishing.
2. **Trusted publisher (once, after 0.1.0 exists on npm), on npmjs.com:**
   `@vendurepos/plugin` → Settings → Trusted Publisher → GitHub Actions:
   Organization or user `vendurepos`, Repository `app`, Workflow filename
   `release-plugin.yml`, Environment left empty. Save. On the same Settings page,
   under Publishing access, choose "Require two-factor authentication and disallow tokens"
   so only the workflow (and 2FA humans) can publish. No `NPM_TOKEN` secret exists or is needed.
3. **Every later release:** a PR bumps `version` in `packages/vendure-plugin/package.json`
   and moves the `CHANGELOG.md` entry from unreleased to the version with its date.
   After it merges, tag the merge commit on `main` and push the tag:

   ```sh
   git tag plugin-vX.Y.Z <merge-commit-sha>
   git push origin plugin-vX.Y.Z
   ```

   The `Release plugin` workflow checks the tag equals `plugin-v` + the package.json
   version and that the commit is on `main`, then typechecks, builds and publishes
   with provenance. A tag that fails either check fails the run and publishes nothing.

<!-- Sources: .github/workflows/release-plugin.yml; packages/vendure-plugin/package.json. -->

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
