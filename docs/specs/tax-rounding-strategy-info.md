# Spec — advertise the store's tax rounding strategy in /info (TallyUI/tallyui#287, server side)

**Status:** ready, gated on a release. Build it the day `@tallyui/core` publishes #287's `taxRounding` capability. #287 is built after order.create v4 (TallyUI #291), so this PR follows `order-create-v4.md`. Before dispatching:
- read `~/.claude/state/route-implementation`;
- copy this into a Codex/Opus job spec;
- check every file:line against `main` on the day;
- read TallyUI's contract docs for each granularity's written-out algorithm.

## The contract (Front desk ruling on TallyUI/tallyui#287, 2026-09-30)

- **Shape:** core's server capabilities gain an optional
  `taxRounding?: { granularity: 'per_order' | 'per_line' | 'per_rate_group'; mode: 'half_away_from_zero' }`.
- **An absent `taxRounding`** means `per_order` / `half_away_from_zero`, which is the till's behaviour today.
- **No flags.** Each granularity's algorithm is written out in TallyUI's contract docs from Vendure's and Medusa's real code. A variant that needs a different algorithm gets its own granularity **name**. `mode` has one value until a store needs another.
- **A capability, not an order.create version.** The till reads it at sale time and records the strategy on the sale's own record, not in the payload. The figures are frozen at finalize.
- **Where it goes on the `/info` wire:** follow core's `/info` parser on the day. This plugin's `/info` today is `{ contracts: { 'order.create': [...] } }`, and core's `ServerCapabilities` is the connector's parsed view of it.

## Goal

The plugin's `GET /tally/v1/info` advertises **how this Vendure store rounds tax**, so the till computes its fiscal figures the same way (Front desk ruling on vendurepos/app#38, 2026-09-30).

- The #38 measurement covered 9,680 real orders. The till's per-order rounding and Vendure's per-line or per-rate-group rounding differ by 1–3 minor units on 13–60 % of multi-line sales.
- A till that follows the store's strategy matched Vendure on 0 of 1,420 undiscounted baskets differing.

## Stakes

Every sale's receipt against the store's books. A wrongly advertised strategy makes the till compute the wrong figures on every multi-line sale. It is worse than advertising nothing, which leaves the till at its default rule.

## What to advertise

| Vendure configuration | `taxRounding` |
|---|---|
| `DefaultOrderTaxCalculationStrategy` (Vendure's default, or no `orderTaxCalculationStrategy` set) | `{ granularity: 'per_line', mode: 'half_away_from_zero' }` |
| `OrderLevelTaxCalculationStrategy` | `{ granularity: 'per_rate_group', mode: 'half_away_from_zero' }` |
| Anything else (a custom strategy, including a subclass of either) | **omitted** |

**Why these two names suffice** (measured, #38, told to the TallyUI queue on 2026-09-30):
- **`per_line`:** each line's tax is rounded on its own.
  - Exclusive: `round(net × r)`.
  - Inclusive: `net = round(gross / (1 + r))`, and tax = gross − net.
- **`per_rate_group`:** each line's net is rounded first, which is a no-op for exclusive lines, and the tax is then rounded once per group. The group key is the tax rate's **name and value** (Vendure's `order-level-tax-calculation-strategy.js:103`).
- Each matched real Vendure on 0 of 1,420 baskets in both price modes. So neither needs a separate inclusive-prices name.

**Rounding-mode caveat:**
- Vendure's `DefaultMoneyStrategy` is `Math.round`, which rounds **half up**. That equals `half_away_from_zero` except on exact negative halves, e.g. a −59.5 discount surcharge becomes −59, not −60 (already noted in ADR 0002).
- The ruled contract has only `half_away_from_zero`, so advertise that, and state the negative-half difference in ADR 0002.
- If exact `figures_mismatch` later shows such cases, the fix is a contract mode value, ruled by the Front desk, not a local workaround.

**Detect by exact class, never by name string.** Compare `config.taxOptions.orderTaxCalculationStrategy.constructor` with Vendure's `DefaultOrderTaxCalculationStrategy` and `OrderLevelTaxCalculationStrategy`. Do not use `instanceof`: a subclass may round differently, so it counts as custom and is omitted. The dev store sets `OrderLevelTaxCalculationStrategy` (`dev/vendure-store/src/vendure-config.ts:58`).

## In scope

- **`packages/vendure-plugin/src/api/info.controller.ts`** adds the field. Read Vendure's `ConfigService` (inject it) and map the strategy once at bootstrap. It is store-wide, so it is the same for every channel.
- **`packages/vendure-plugin/src/service/tax-rounding.ts`** (new): maps the configured strategy to the advertised value, per the table above. It is a pure function over the strategy instance.
- **`packages/vendure-plugin/test/info-tax-rounding.e2e.ts`** (new): the three rows, each with its own `createPluginTestEnvironment` option. `test/tax-order-level.e2e.ts` shows how an environment gets the order-level strategy.
- **`docs/adr/0002-order-path-vendure-plugin.md`:**
  - §5 "Versions" / `/info`: what is advertised and why, plus the half-up caveat;
  - the subtotal/tax warning bullet: `figures_mismatch` may ship once tills that follow the strategy are released. That is its own PR, comparing exactly, and not part of this one.

## Out of scope

- `figures_mismatch` (its own PR, after this one and after the till release that follows the strategy).
- `src/vendored/**`, which is never hand-edited.
- The `apps/pos` pin bump, which is its own PR.

## Tests

1. **Default strategy:** `/info` advertises `{ granularity: 'per_line', mode: 'half_away_from_zero' }`.
2. **Order-level strategy:** `{ granularity: 'per_rate_group', mode: 'half_away_from_zero' }`.
3. **A subclass of `OrderLevelTaxCalculationStrategy`, and an unrelated custom strategy:** `taxRounding` is **absent**, and the rest of `/info` is unchanged.
4. **`/info`'s existing `contracts`** are unchanged in all three.

## Mutation checks (the dispatching session reruns each)

- The mapping returns `per_line` for the order-level strategy: test 2 fails.
- Detection uses `instanceof`, so the subclass is advertised as `per_rate_group`: test 3 fails.

## Acceptance

From `packages/vendure-plugin`, with `npm run db:up` / `db:down` around them and each after `~/.claude/bin/wait-test-slot.sh`:
1. `npm run build`
2. `npm run typecheck`
3. `npx vitest run test/info-tax-rounding.e2e.ts test/versions.e2e.ts test/harness.e2e.ts --maxWorkers=1`
4. the full `npx vitest run --maxWorkers=1`

## References

vendurepos #38 (the measurement and the ruling), #51/#56 (the seed's rate groups); TallyUI/tallyui#287, #291, #285, #288 (per-line rate identity, which `per_rate_group` needs on the till side); ADR 0002 §5.
