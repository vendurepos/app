# Measurements

## Initial sync of the 2,000-product seed

PLAN §1: "Initial sync of the 2,000-product seed is measured and reported. It is not a gate." (#97)

A till signs in to the large-seed dev store (`VENDURE_SEED=large`: 2,000 products and 5,595 variants on the POS
channel) with an empty local database, and syncs the whole catalogue.

| Run | Sign-in to first render (ms) | Sign-in to complete (ms) | Products | Variants |
|---|---:|---:|---:|---:|
| 1 | 1,922 | 9,205 | 2,000 | 5,595 |
| 2 | 1,943 | 9,142 | 2,000 | 5,595 |
| 3 | 1,884 | 8,962 | 2,000 | 5,595 |
| **Median** | **1,922** | **9,142** | | |
| **Range** | 1,884–1,943 | 8,962–9,205 | | |

| | |
|---|---|
| Date | 2026-10-01 |
| Machine | Mac mini, Apple M6 (12 cores), 24 GB, macOS 27.0 |
| Browser | Chrome for Testing 153.0.8010.12, headless (Playwright 1.63.0 Chromium) |
| Build | the static web export (`pnpm --filter @vendurepos/pos build:web`, served by `expo serve`) |
| Store | Vendure 3.7.3 dev store and Postgres 16 in Docker (Colima), on the same machine |
| App | `@tallyui/*` 3.0.0-next.2, SQLite-wasm (OPFS) local database |

What is timed, from the moment the sign-in submit is clicked:

- **First render:** the first product tile is visible.
- **Complete:** the app's own end of the first sync, `lastSyncedAt` in `apps/pos/lib/use-catalogue.ts` (set when
  the first replication run goes inactive without an error; it hides TallyUI's "Syncing catalogue…" status), and
  then the counts are exact.

The counts are read from the TallyUI `Catalogue`'s React props, reached through the React fiber of its search input:
`products` is the app's live `db.products.find()` over the till's local RxDB database, and each Vendure product
document holds its variants, so the products are `products.length` and the variants the sum of
`products[i].variants.length`. The run fails unless they are exactly 2,000 and 5,595 within 15 seconds of
`lastSyncedAt`, or if the sync has not completed within 10 minutes. In these runs the counts were already exact at
the first read after `lastSyncedAt`. The spec polls every 100 ms, so each timing is up to about 100 ms late.

Each run is a fresh browser context, so an empty local database; the store is reset and seeded once for the three.

### Reproduce

From the repo root, with Docker running:

```bash
pnpm measure:sync
```

`scripts/measure-sync.sh` resets and starts the large-seed store on its own ports and compose project (Vendure
:3400, Postgres :5530, `vendurepos-measure`), builds the web export, serves it on :8199, runs
`apps/pos/e2e/measure-sync.spec.ts` three times (`--repeat-each=3`), prints one JSON line per run, and tears
everything down, the database volume included, even on failure. CI does not run it, and `pnpm smoke:web` skips the
spec.
