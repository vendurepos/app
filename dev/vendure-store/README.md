# Vendure dev store

The Vendure 3.7.3 store that VendurePOS develops and tests against. It runs
on this Mac mini only, bound to 127.0.0.1, and **never on the production
VPS** (plan ADR-058). Postgres 16 runs in Docker; Vendure runs as one Node
process that also works the job queue.

This is a standalone npm package, not part of the pnpm workspace.

## Commands

Run from `dev/vendure-store/`. Needs Node `^20.19 || >=22.12`, npm, and a
running Docker (Colima on the Mac mini).

```bash
./plugin.sh            # build @vendurepos/plugin, then npm ci here, each only when needed
./reset.sh             # wipe the database volume and seed it
./start.sh             # start Vendure detached; waits until the Shop API answers
./stop.sh              # stop Vendure and the Postgres container (data kept)
./smoke.sh             # reset + start + checks, then stop (KEEP_RUNNING=1 keeps it up)
```

The store runs `@vendurepos/plugin` from `packages/vendure-plugin`, installed as
`file:../../packages/vendure-plugin`. `.npmrc` sets `install-links`, so npm copies the package's
`dist/` into `node_modules` instead of linking it, and the plugin resolves this store's
`@vendure/core`. **Build the plugin before this store's `npm ci`**
(`cd ../../packages/vendure-plugin && npm ci && npm run build`). `plugin.sh` does both when the
plugin's `dist/` is missing or older than its sources, or this store's copy differs, and `reset.sh`,
`start.sh` and `smoke.sh` run it first.

`start.sh` refuses to start on an empty database; run `./reset.sh` first.
The server log is `.run/vendure.log`, the pid `.run/vendure.pid`.

### Ports

| What | Default | Override |
|---|---|---|
| Vendure (Admin and Shop API) | `127.0.0.1:3000` | `VENDURE_PORT` |
| Postgres | `127.0.0.1:5442` | `VENDURE_DB_PORT` |
| Postgres database | `vendure` | `VENDURE_DB_NAME` |

`pnpm e2e` (`scripts/e2e.sh`, plan VA6) runs a copy of this store in a temporary directory with the plugin
`npm pack`ed and `npm install`ed from the tarball, on :3100 with the database `vendurepos_e2e` on :5501
(compose project `vendurepos-e2e`), and removes all of it on exit.

On the Mac mini, `~/Projects/vendure-dev` (a separate local store) holds
:3000 today, so run this one on another port until the two are
consolidated:

```bash
VENDURE_PORT=3200 ./smoke.sh
VENDURE_PORT=3200 ./start.sh
```

Pass the same variables to every script in a session.

## What you get

| | |
|---|---|
| Admin API | `http://127.0.0.1:3000/admin-api` |
| Shop API | `http://127.0.0.1:3000/shop-api` |
| Superadmin | `superadmin` / `superadmin` |
| Token methods | `bearer`, `cookie`, `api-key` |
| CORS origins | `localhost` and `127.0.0.1` on :8081 (Expo), :8099 (web export) and :8199 (`pnpm measure:sync`) |
| Tax strategy | `OrderLevelTaxCalculationStrategy` |
| POS commands | `POST /tally/v1/commands` (`TallyPosPlugin`; bearer token, `vendure-token`, `X-Tally-Protocol: 1`) |

On start the plugin gives every channel the `tally-pos` payment method, the `tally-in-store`
shipping method and the walk-in customer; the seed creates none of them.

`./smoke.sh` checks the catalogue, the login and the POS channel, then sells 1 × `TALLY-MUG`
through the command route (a v3 `order.create`, 952 cash): `applied`, the order `Delivered` at
952, Shop floor stock down by 1; the replay is `duplicate` with the same order; a batch
without `X-Tally-Protocol` answers 400.

Channels (both EUR, prices tax-exclusive, default tax zone Germany):

| Channel | Code | `vendure-token` |
|---|---|---|
| Default | `__default_channel__` | `vendurepos-dev-default` |
| POS | `pos` | `vendurepos-dev-pos` |

The default seed (`src/catalogue.ts`) is deterministic: every reset gives the same
ids, prices, barcodes and stock. It is the small POS catalogue used by e2e tests.

- **Tax:** categories `Standard` (DE 19%, DK 25%) and `Reduced` (DE 7%; DK 25%, as
  Denmark has no reduced rate). Zones `Germany` (the default) and `Denmark`. The two
  categories are separate rate groups in the default zone, so a single-rate order is
  never bridged under the order-level strategy, and `smoke:check` proves it.
- **Products:** 10 products, 21 variants, including `tally-fixture-mug`
  (`TALLY-MUG`, €8.00), a 6-variant T-shirt (size × colour), `PRINT-LTD`
  with 2 in stock, and an untracked gift card.
- **Barcodes:** `ProductVariant.barcode` custom field, EAN-13 in the GS1
  in-store range: `200` + the variant's 1-based position + a check digit
  (`TALLY-MUG` is `2000000000015`).
- **Stock locations:** `Warehouse` and `Shop floor`, each with its own
  stock level per variant (`TALLY-MUG`: 100 and 50). The POS channel sees
  only `Shop floor`; the default channel sees both.
- **Prices:** tax-exclusive, so `TALLY-MUG` is `price` 800 and
  `priceWithTax` 952 in the Germany zone.

## Large seed

`VENDURE_SEED=large` selects a generated, deterministic catalogue of 2,000 products
and 5,595 variants, with EAN-13 barcodes, generated prices, tax categories and stock.
The first product remains `TALLY-MUG`. From `dev/vendure-store/`:

```bash
export VENDURE_PORT=3300 VENDURE_DB_PORT=5520 COMPOSE_PROJECT_NAME=vendurepos-va2
VENDURE_SEED=large ./reset.sh
./start.sh
VENDURE_SEED=large npm run --silent seed:check
./stop.sh
```

To restore the default 10-product, 21-variant seed, run `./reset.sh` with
`VENDURE_SEED` unset, then `./start.sh` and `npm run --silent seed:check`.
The check reads POS channel counts from the Admin API and allows a 1% difference.

## Try it

```bash
curl -s -D - http://127.0.0.1:3000/admin-api \
  -H 'content-type: application/json' \
  --data '{"query":"mutation { login(username: \"superadmin\", password: \"superadmin\") { ... on CurrentUser { identifier } } }"}' \
  | grep -i vendure-auth-token

curl -s http://127.0.0.1:3000/shop-api \
  -H 'content-type: application/json' -H 'vendure-token: vendurepos-dev-pos' \
  --data '{"query":"{ products(options: { take: 3 }) { totalItems items { name } } }"}'
```

## Changing the schema

The server runs with `synchronize: false` and no migrations. The seed builds
the schema with `synchronize: true` on an empty database, the plugin's
`tally_command` ledger and order custom fields included, so after changing
custom fields or adding a plugin with entities, run `./reset.sh`.
