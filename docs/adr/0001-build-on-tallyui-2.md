# Build on TallyUI 2.0.0 and mirror medusapos

Status: Accepted
Date: 2026-09-28

## Context

VendurePOS is the second platform POS after MedusaPOS. The plan
([PLAN.md](../PLAN.md)) puts the platform-neutral code in TallyUI and keeps
only Vendure-specific sign-in, settings, wiring and the server plugin here.
MedusaPOS started by consuming TallyUI from a sibling checkout through
`pnpm.overrides` with `file:` links, because the packages it needed were not
yet published. That needed a second checkout in CI (`TALLYUI_REF`), tsconfig
`paths` and a Metro resolver hook. TallyUI 2.0.0 is now on npm, including
`@tallyui/connector-vendure` and `@tallyui/primitives`.

## Decision

- The app depends on the published `@tallyui/*` packages at exactly `2.0.0`:
  core, components, primitives, theme, pos, database and connector-vendure.
  No `file:` or `link:` versions and no `pnpm.overrides` for them. A unit
  test fails if any `@tallyui/*` dependency is not an exact published version.
- The repo mirrors medusapos/app's structure: a pnpm workspace (`apps/*`)
  driven by turbo, root `typecheck`, `test` (vitest) and `lint` scripts, and
  a CI workflow that installs with a frozen lockfile, typechecks and tests.
- The Expo app lives at `apps/pos` (package `@vendurepos/pos`), not
  `apps/expo` as in medusapos and in the plan's §2 table. Later plan jobs
  (VA8's Vercel root directory in particular) use `apps/pos`.
- `@tallyui/storage-sqlite` is left out until the RxDB Premium licence
  question (plan V-D5) is settled, since it needs `rxdb-premium` as a peer.

## Consequences

- CI needs no TallyUI checkout and no `TALLYUI_REF`. TallyUI changes reach
  this repo only when TallyUI publishes and a PR here bumps every
  `@tallyui/*` package together.
- A TallyUI fix the app needs waits for a TallyUI release, unlike medusapos,
  which picks up an unreleased commit.
- The app uses TallyUI's compiled `dist/` output, so it needs neither
  tsconfig `paths` nor a Metro resolver hook.
