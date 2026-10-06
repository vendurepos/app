# VendurePOS app

Point of sale for Vendure, built on TallyUI. The house rules in
`~/Projects/CLAUDE.md` apply in full; this file adds only what is specific to
this repo.

## Lanes

- **`main` only for now.** Every change is a PR to `main` from a feature
  branch in a worktree. There is no `next` lane yet; when one is added, it is
  named here.
- Direct pushes to `main` are Paul's call.

## Where things live

- `apps/pos` — the Expo Router app (`@vendurepos/pos`).
- `docs/PLAN.md`, `docs/DISCOVERY.md` — copies of TallyUI's
  `docs/vendure/`. The canonical copies are in TallyUI; change them there and
  re-copy, never edit the copies here.
- `docs/adr/` — this repo's decisions, numbered `NNNN-short-title.md`, in the
  same format as medusapos (`Status`, `Date`, Context / Decision /
  Consequences).
- `docs/scan-policy.md` — what a barcode scan does on each surface (Front desk rulings).
- Job ids in the plan: **VA** jobs belong to this repo, **VP** jobs to the
  Vendure plugin that will live here, **TV** jobs to TallyUI (another repo,
  dispatched separately).

## TallyUI

- The app consumes the **published** `@tallyui/*` packages from npm, pinned
  to an exact version (3.7.0 today). Never `file:`, `link:` or
  `pnpm.overrides` pointing at a local TallyUI checkout; a test enforces the
  pin. A TallyUI upgrade is a deliberate PR that bumps every `@tallyui/*`
  package together.
- Platform-neutral code (the "would Woo, Medusa, Shopify use it unchanged?"
  test) belongs in TallyUI, not here.

## Checks

Run from the repo root, one at a time (the machine runs one suite at a time):

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # vitest, capped at 2 workers
pnpm lint
```

CI (`.github/workflows/ci.yml`) runs install, typecheck and test.

## Scope

- `vendurepos-web` (the marketing site) is a separate repo and out of scope
  here.
- Nothing for this repo runs on the production VPS. The Vendure dev store
  runs on the Mac mini (plan ADR-058).
