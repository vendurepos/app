# VendurePOS

Open source, modular point of sale for [Vendure](https://vendure.io). Built on
[TallyUI](https://github.com/TallyUI/tallyui).

> **Status: MVP.** A web till for your Vendure store that sells offline, with a
> [demo to try in your browser](https://demo.vendurepos.com/demo).

## What it does

A web till signed in to the merchant's own Vendure 3.6+ store (3.7.3 tested),
with the `@vendurepos/plugin` server plugin installed. The till:

- Signs in with a staff account, or with a device key made for that till in
  the Vendure Dashboard (see [docs/QUICKSTART.md](docs/QUICKSTART.md)).
- Syncs the catalogue to local SQLite in the browser.
- Browses products by category (the store's collections) and as a grid or a table.
- Sells with the network off. Each sale waits in a local outbox. When the
  network returns, it lands in Vendure exactly once, at the POS price, paid
  and fulfilled.
- Takes line and order discounts.
- Takes cash payments with change, or card payments on a separate terminal,
  confirmed on the till.
- Splits a sale between cash and a card terminal, and the order records both
  payments.
- Prints the receipt.
- Runs a register day: open with a float, cash in and out, count, close, and
  a printed Z report. A count difference over the till's limit (set in
  Settings) needs a manager's approval to close.
- Shows sales the store refused under "needs attention", with a retry.
- Reads barcode scans from a keyboard-wedge scanner.

Try it: [demo](https://demo.vendurepos.com/demo) with a simulated store,
everything in the browser and nothing to install, or the
[hosted app for your own store](https://app.vendurepos.com).

The plan is in [docs/PLAN.md](docs/PLAN.md), and what the POS needs from
Vendure is in [docs/DISCOVERY.md](docs/DISCOVERY.md). Both are copies; the
canonical versions live in TallyUI under `docs/vendure/`. Decisions for this
repo are in [docs/adr/](docs/adr/).

## Install on your store

Install `@vendurepos/plugin` from npm. Follow [docs/QUICKSTART.md](docs/QUICKSTART.md)
for plugin installation, migration, CORS origin, bearer token method and tax strategy.
See the [plugin reference](packages/vendure-plugin/README.md).

## Structure

- `apps/pos` — Expo Router app (web first). It depends on the published
  `@tallyui/*` 3.5.1 packages from npm, pinned exactly, including
  `@tallyui/connector-vendure`.
- `packages/vendure-plugin` — the Vendure plugin `@vendurepos/plugin`. It runs
  TallyUI's `order.create` and register commands, one Postgres transaction per
  command, with its own npm lockfile.
- `dev/vendure-store` — the local Vendure 3.7.3 dev store (see its README).

## Known limitations

- An open till picks up a price change made in Vendure within about a minute, and a stock change within about five minutes (the stock reconcile interval), or at once when the till comes back to the foreground or back online.
- Sales take stock from the channel's default stock location. The till cannot
  pick a location (vendurepos/app#35).
- One browser tab per till: a second tab is told to close the first.
- Private browser windows that give a site no storage, such as Safari's,
  can't run the till.
- The manager's approval on register close is a typed name, not a verified
  sign-in.

## Getting started

Requires Node.js 22 and pnpm (the version is pinned in `package.json`).
The web storage uses RxDB Premium, whose install script needs the licence
token in `RXDB_PREMIUM` (CI reads the repository secret of that name).

```bash
pnpm install
pnpm --filter @vendurepos/pos exec tallyui-build-sqlite-worker public/   # the SQLite web worker
pnpm --filter @vendurepos/pos web   # http://localhost:8081
```

## Web till and plain-http stores

A web till served over https talks to https stores only: the browser's
mixed-content rule blocks http before the Content-Security-Policy does.
`http://localhost` and `http://127.0.0.1`, on any port, are allowed for
development. The sign-in screen's plain-http rule for loopback, private and
`.local` hosts is for the native apps, and for a web export served over plain
http on the same LAN as the store. That LAN build needs
`VENDUREPOS_WEB_ALLOW_LAN_HTTP=1` at build time, which adds `http:` to the
CSP's `connect-src` and `img-src`, since product images come from the same
store. It is off by default.

No public source maps on any site that bundles RxDB Premium (its licence forbids redistributing the source); `scripts/check-web-bundle.sh` fails the build if a `.map` is emitted.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm lint
```

CI runs typecheck and unit tests, the plugin's typecheck and Postgres e2e,
the web smoke, the offline e2e and the demo e2e. The offline e2e (`pnpm e2e`)
packs the plugin into a fresh store, then runs 25 sales, 20 of them offline.
The demo e2e (`pnpm e2e:demo`) runs the demo build with no backend.
`pnpm e2e:hosted` runs the same spec against the hosted demo
(demo.vendurepos.com), with the host's own CSP headers.

The web smoke resets and starts the dev store on port 3200, exports the web
app, serves it on 127.0.0.1:8099, signs in through the UI in Playwright
Chromium and checks the seeded catalogue appears. It needs Docker (Colima on
the Mac mini) and stops the store when
it ends:

```bash
pnpm smoke:web
```

`pnpm measure:sync` times a till's initial sync of the 2,000-product seed on
its own ports and tears it down; the numbers are in `docs/measurements.md`.

## License

MIT
