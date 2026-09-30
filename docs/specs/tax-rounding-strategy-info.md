# Spec — advertise the store's tax rounding strategy in /info (TallyUI/tallyui#287, server side)

**Status:** ready, gated on a release. Build it the day `@tallyui/core` publishes #287's `taxRounding` capability. #287 is built after order.create v4 (TallyUI #291), so this PR follows `order-create-v4.md`. Before dispatching:
- read `~/.claude/state/route-implementation`;
- copy this into a Codex/Opus job spec;
- check every file:line against `main` on the day;
- read TallyUI's contract docs for each granularity's written-out algorithm.

## The contract (Front desk ruling on TallyUI/tallyui#287, 2026-09-30)

- **Shape:** core's server capabilities gain an optional
  `taxRounding?: { granularity: 'per_order' | 'per_line' | 'per_rate_group'; mode: 'half_away_from_zero' | 'half_up' } | { granularity: 'custom' }` (`half_up` and `custom` added by the Front desk, 2026-09-30: Vendure's money strategy is `Math.round`, and a store the server cannot describe must say so).
- **An absent `taxRounding`** means an older server: the till assumes `per_order` / `half_away_from_zero`, its behaviour today. **`{ granularity: 'custom' }`** (no `mode`) means a store whose rounding the server cannot describe: the till uses its default figures, and that server never emits `figures_mismatch` for subtotal or tax.
- **No flags.** Each granularity's algorithm is written out in TallyUI's contract docs from Vendure's and Medusa's real code. A variant that needs a different algorithm gets its own granularity **name**. The two `mode` values differ only on exact negative halves.
- **A capability, not an order.create version.** The till reads it at sale time and records the strategy on the sale's own record, not in the payload. The figures are frozen at finalize.
- **Where it goes on the `/info` wire:** follow core's `/info` parser on the day. This plugin's `/info` today is `{ contracts: { 'order.create': [...] } }`, and core's `ServerCapabilities` is the connector's parsed view of it.

## Goal

The plugin's `GET /tally/v1/info` advertises **how this Vendure store rounds tax**, so the till computes its fiscal figures the same way (Front desk ruling on vendurepos/app#38, 2026-09-30).

- The #38 measurement covered 9,680 real orders. The till's per-order rounding and Vendure's per-line or per-rate-group rounding differ by 1–3 minor units on 13–60 % of multi-line sales.
- A till that follows the store's strategy matched Vendure on 0 of 1,420 undiscounted baskets differing.

## Stakes

Every sale's receipt against the store's books. A wrongly advertised strategy makes the till compute the wrong figures on every multi-line sale. It is worse than advertising `{ granularity: 'custom' }`, which leaves the till at its default figures.

## What to advertise

| Vendure configuration | `taxRounding` |
|---|---|
| `DefaultOrderTaxCalculationStrategy` (Vendure's default, or no `orderTaxCalculationStrategy` set) | `{ granularity: 'per_line', mode: 'half_up' }` |
| `OrderLevelTaxCalculationStrategy` | `{ granularity: 'per_rate_group', mode: 'half_up' }` |
| Anything else (a custom tax strategy, including a subclass of either), or a money strategy other than `DefaultMoneyStrategy` | `{ granularity: 'custom' }` (no `mode`). **Never omit the field:** absence means an older server, which is the wrong assumption for exactly this store. |

**Why these two names suffice** (measured, #38, told to the TallyUI queue on 2026-09-30):
- **`per_line`:** each line's tax is rounded on its own.
  - Exclusive: `round(net × r)`.
  - Inclusive: `net = round(gross / (1 + r))`, and tax = gross − net.
- **`per_rate_group`:** each line's net is rounded first, which is a no-op for exclusive lines, and the tax is then rounded once per group. The group key is the tax rate's **name and value** (Vendure's `order-level-tax-calculation-strategy.js:103`).
- Each matched real Vendure on 0 of 1,420 baskets in both price modes. So neither needs a separate inclusive-prices name.

**Known gaps (keep in view; the till's side is TallyUI's):**
- **Discounted baskets:**
  - The 0-of-1,420 result is for **undiscounted** baskets. The plugin posts each line discount as its own `TALLY-DISCOUNT` Surcharge, and Vendure rounds each surcharge as its own item (`surcharge.entity.js:33-38`), not prorated into the line's net (see `order-create-v4.md`, "How Vendure sees a discount today").
  - A till that applies the store's rounding to discounted line nets will therefore differ from Vendure on discounted baskets. Measured on 4,000 discounted real-Vendure orders: only the per-item rule, each item rounded half up, matches in all four cells. The ruling on which side changes is the Front desk's.
- **`per_rate_group` with all tax-inclusive lines:**
  - Until TallyUI files and ships the contract fix, the till computes such baskets **per order** (Front desk, 2026-09-30). Once `figures_mismatch` ships, those baskets keep raising it as a **warning**, never a refusal.
  - The ADR 0002 note that goes with `figures_mismatch` says so, and names the TallyUI issue once it exists.

**Rounding mode:** Vendure advertises `half_up`.
- Vendure's `DefaultMoneyStrategy` is `Math.round`, which rounds **half up**. It differs from `half_away_from_zero` only on exact negative halves, e.g. a −59.5 discount surcharge becomes −59, not −60 (already noted in ADR 0002). The contract gained `half_up` for exactly this (Front desk, 2026-09-30).
- `DefaultMoneyStrategy` is Vendure's default, and `moneyStrategy` is configurable. A store with a different money strategy has unknown rounding, so it advertises `{ granularity: 'custom' }`, as a custom tax strategy does. Detect the exact class, as below.

**Detect by exact class, never by name string.** Compare `config.taxOptions.orderTaxCalculationStrategy.constructor` with Vendure's `DefaultOrderTaxCalculationStrategy` and `OrderLevelTaxCalculationStrategy`. Do not use `instanceof`: a subclass may round differently, so it counts as custom and advertises `{ granularity: 'custom' }`. The dev store sets `OrderLevelTaxCalculationStrategy` (`dev/vendure-store/src/vendure-config.ts:58`).

## In scope

- **`packages/vendure-plugin/src/api/info.controller.ts`** adds the field. Read Vendure's `ConfigService` (inject it) and map the strategy once at bootstrap. It is store-wide, so it is the same for every channel.
- **`packages/vendure-plugin/src/service/tax-rounding.ts`** (new): maps the configured strategy to the advertised value, per the table above. It is a pure function over the strategy instance.
- **`packages/vendure-plugin/test/info-tax-rounding.e2e.ts`** (new): the three rows, each with its own `createPluginTestEnvironment` option. `test/tax-order-level.e2e.ts` shows how an environment gets the order-level strategy.
- **`docs/adr/0002-order-path-vendure-plugin.md`:**
  - §5 "Versions" / `/info`: what is advertised and why, plus the half-up caveat;
  - the subtotal/tax warning bullet: `figures_mismatch` may ship once tills that follow the strategy are released. That is its own PR, comparing exactly, and not part of this one. A store advertising `custom` never gets a subtotal or tax `figures_mismatch` from this server.

## Out of scope

- `figures_mismatch` (its own PR, after this one and after the till release that follows the strategy).
- `src/vendored/**`, which is never hand-edited.
- The `apps/pos` pin bump, which is its own PR.

## Tests

1. **Default strategy:** `/info` advertises `{ granularity: 'per_line', mode: 'half_up' }`.
2. **Order-level strategy:** `{ granularity: 'per_rate_group', mode: 'half_up' }`.
3. **A subclass of `OrderLevelTaxCalculationStrategy`, an unrelated custom tax strategy, and a custom money strategy:** each advertises exactly `{ granularity: 'custom' }` with **no `mode`**, the field is present (never absent), and the rest of `/info` is unchanged.
4. **`/info`'s existing `contracts`** are unchanged in all three.

## Mutation checks (the dispatching session reruns each)

- The mapping returns `per_line` for the order-level strategy: test 2 fails.
- Detection uses `instanceof`, so the subclass is advertised as `per_rate_group`: test 3 fails.
- A custom strategy omits `taxRounding` instead of advertising `{ granularity: 'custom' }`: test 3 fails.

## Acceptance

From `packages/vendure-plugin`, with `npm run db:up` / `db:down` around them and each after `~/.claude/bin/wait-test-slot.sh`:
1. `npm run build`
2. `npm run typecheck`
3. `npx vitest run test/info-tax-rounding.e2e.ts test/versions.e2e.ts test/harness.e2e.ts --maxWorkers=1`
4. the full `npx vitest run --maxWorkers=1`

## References

vendurepos #38 (the measurement and the ruling), #51/#56 (the seed's rate groups); TallyUI/tallyui#287, #291, #285, #288 (per-line rate identity, which `per_rate_group` needs on the till side); ADR 0002 §5.
