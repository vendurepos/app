# VendurePOS

Open source, modular point of sale for [Vendure](https://vendure.io). Built on
[TallyUI](https://github.com/TallyUI/tallyui).

> **Status: pre-MVP.** This repository is a skeleton. The app boots to a
> placeholder screen and does not talk to Vendure yet.

## What it will be

A cashier opens the hosted POS, signs in to their own Vendure store and sells
with the network off. When the network comes back, every order lands in
Vendure exactly once, at the POS price, paid and fulfilled. It is the
[MedusaPOS](https://github.com/medusapos/app) MVP again, on Vendure: the
platform-neutral pieces live in TallyUI, and this repo holds the Vendure
sign-in, store settings, wiring and server plugin.

The plan is in [docs/PLAN.md](docs/PLAN.md), and what the POS needs from
Vendure is in [docs/DISCOVERY.md](docs/DISCOVERY.md). Both are copies; the
canonical versions live in TallyUI under `docs/vendure/`. Decisions for this
repo are in [docs/adr/](docs/adr/).

## Structure

- `apps/pos` — Expo Router app (iOS, Android, Web). It depends on the
  published `@tallyui/*` 2.0.0 packages from npm, including
  `@tallyui/connector-vendure`.

The Vendure plugin (`packages/vendure-plugin`) and the dev store
(`dev/vendure-store`) arrive with later jobs in the plan.

## Getting started

Requires Node.js 22 and pnpm (the version is pinned in `package.json`).

```bash
pnpm install
pnpm --filter @vendurepos/pos web   # http://localhost:8081
```

## Checks

```bash
pnpm typecheck
pnpm test
pnpm lint
```

CI runs install, typecheck and test on every pull request.

## License

MIT
