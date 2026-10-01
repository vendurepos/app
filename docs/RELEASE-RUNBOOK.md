# VendurePOS release runbook

**Nothing in this runbook is run until the Front desk says so.** This is release
preparation, not evidence of a deployment, DNS change or npm publication.

## Plugin 0.1.0

1. Obtain publish access to the **`@vendurepos` npm organisation**.
2. In a release PR, remove `"private": true` from
   `packages/vendure-plugin/package.json`; retain version `0.1.0` for this release.
   It remains private in this preparation change.
3. From `packages/vendure-plugin`, run:

   ```sh
   npm run build
   npm pack --dry-run
   ```

   Review the file list and tarball size: compiled `dist/` JavaScript and
   declarations, the main and `./email` entries, all three migrations, README
   and package metadata. The current `files` list is `dist` and `README.md`; the
   changelog stays in the repository. **There is no `LICENSE` file today**:
   `package.json` declares MIT, so the release PR adds `LICENSE` (npm ships it
   automatically). The dry run on 2026-10-01 listed 70 files, 72.0 kB packed and
   277.7 kB unpacked, with no licence file.
4. After approval and the release PR merge, publish from that same directory:

   ```sh
   npm publish --access public
   ```

5. Tag the released commit **`plugin-v0.1.0`** and push that tag as part of the
   authorised release. Publish before directing testers to the install command
   in the [quick-start](QUICKSTART.md).

<!-- Sources: packages/vendure-plugin/package.json; packages/vendure-plugin/src/index.ts; docs/PLAN.md (VA8). -->

## Vercel web app

After Front desk approval, configure Git integration for **`vendurepos/app`**
on the **WCPOS** team, project **`vendurepos`**, production branch **`main`**.
Allow the build to include files outside the root directory for the pnpm workspace.

| Setting | Value |
| --- | --- |
| Framework preset | Other (static Expo export) |
| Root directory | `apps/pos` (the PLAN's `apps/expo` path is stale) |
| Node.js | `22.x` |
| Package manager | `pnpm@10.28.2` |
| Install | `bash -o pipefail -c 'pnpm install --frozen-lockfile 2>&1 \| grep -vi accessToken'` |
| Build | `bash -o pipefail -c 'pnpm --filter @vendurepos/pos build:web 2>&1 \| grep -vi accessToken'` |
| Output directory | `dist` (relative to `apps/pos`) |
| Domain | `app.vendurepos.com` |

The underlying web export command is `pnpm --filter @vendurepos/pos build:web`.
The wrappers preserve failures and filter licence-token output as CI does.
There are no store-specific runtime environment variables: the store URL and
credentials are entered at sign-in. **Build/install needs the `RXDB_PREMIUM`
secret** used in CI to decrypt the licensed dependency; set it only for approved
builds, never as an `EXPO_PUBLIC_` variable. Leave
`VENDUREPOS_WEB_ALLOW_LAN_HTTP` unset: this hosted build is HTTPS-only and uses
the unmodified meta CSP, not the LAN `http:` connect/image-source expansion.
<!-- Sources: .github/workflows/ci.yml; pnpm-workspace.yaml; package.json; apps/pos/package.json; apps/pos/app.json; apps/pos/lib/sign-in.ts; apps/pos/scripts/csp-lan-http.ts. -->

Add the domain in the project's Domains settings, then create a **CNAME** record
with name **`app`** in the **`vendurepos.com`** DNS zone. Use the exact target
Vercel displays for that project/domain; obtain it at release time, rather than
guessing a project-specific DNS target. Wait for domain verification and HTTPS.

`apps/pos/vercel.json` leaves `cleanUrls` disabled. Vercel serves existing files
and rewrites unmatched paths to `/index.html`. Its `/(.*)` header rule applies
the meta CSP plus `frame-ancestors 'none'` to every response, including the SQLite
worker's own response, with `nosniff` and `strict-origin-when-cross-origin`.
The worker needs `'wasm-unsafe-eval'` in that response policy to compile SQLite.
After deployment, check the root, a deep SPA link and a worker asset for the CSP,
then follow the [quick-start](QUICKSTART.md) against a tester's store to a sale.
<!-- Sources: docs/PLAN.md §2 and VA8; apps/pos/vercel.json; apps/pos/public/index.html; apps/pos/scripts/serve-web.ts. -->
