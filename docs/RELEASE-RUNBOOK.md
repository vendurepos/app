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

The production address is `https://app.vendurepos.com`. The alias
`https://vendurepos.vercel.app` serves the same production deployment.
Project `vendurepos` is in the WCPOS team (CLI scope `wcpos`) and is
Git-linked to `vendurepos/app`.

Vercel builds every push to `main` and nothing else. The ignored build step is
`if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1; else exit 0; fi`.
On a PR, "Canceled by Ignored Build Step" is expected.
The root directory is `apps/pos`, Node is `22.x`, and the output directory is
`dist`. The install and build commands are:

```sh
bash -o pipefail -c 'pnpm install --frozen-lockfile 2>&1 | grep -vi accesstoken'
bash -o pipefail -c 'pnpm build:web 2>&1 | grep -vi accesstoken'
```

Both commands filter `accesstoken` because rxdb-premium's install and build can
print the licence token. `RXDB_PREMIUM` is a sensitive project variable that
supplies the licence the install needs. It never goes in a repo file.
The project also sets `ENABLE_EXPERIMENTAL_COREPACK`.

Read deploy state with `vercel ls vendurepos --scope wcpos --prod`.

The future demo site at `demo.vendurepos.com` (VA9) will use a separate Vercel
project. It must build with `pnpm build:web:demo`. That script in
`apps/pos/package.json` gives Metro its own `TMPDIR`, because Metro's shared
transform cache is not keyed by `EXPO_PUBLIC_VENDUREPOS_DEMO`. A normal build
could otherwise come out as the demo.

`apps/pos/vercel.json` leaves `cleanUrls` disabled. Vercel serves existing files
and rewrites unmatched paths to `/index.html`. Its `/(.*)` header rule applies
the meta CSP plus `frame-ancestors 'none'` to every response, including the SQLite
worker's own response, with `nosniff` and `strict-origin-when-cross-origin`.
The worker needs `'wasm-unsafe-eval'` in that response policy to compile SQLite.
After a production deploy, verify `/`, a deep link and `/tallyui-sqlite-worker.js` return
200 with the CSP header including `'wasm-unsafe-eval'`; `sqlite3.wasm` must be
served as `application/wasm`. Then follow the [quick-start](QUICKSTART.md)
against a tester's store to a sale.
<!-- Sources: docs/PLAN.md §2 and VA8; apps/pos/vercel.json; apps/pos/public/index.html; apps/pos/scripts/serve-web.ts; the Vercel project settings (vercel api /v9/projects/vendurepos). -->
