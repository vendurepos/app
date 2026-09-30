# Spec — adopt order.create version 4 (net discounts)

**Status:** ready, gated on a release. Build it the day `@tallyui/core` and `@tallyui/pos` publish version 4 (TallyUI #291, closing #286) **and** vendurepos bumps its `@tallyui/*` pin to that release. That bump is its own deliberate PR, per this repo's CLAUDE.md. Before dispatching, read `~/.claude/state/route-implementation`, copy this into a Codex/Opus job spec, and check every file:line against `main` on the day, because they move.

## Goal

The plugin accepts `order.create` **version 4**, where every `discountMinor`, the order's and each line's, is **tax-exclusive**. It applies a net line discount correctly on a tax-inclusive line, and it advertises 4 in `/info` in the same PR, not before (Front desk, 2026-09-30; vendurepos/app#53).

## Stakes

This is the money path. A net discount applied as gross on an inclusive line under-discounts by the tax on the discount, and the rounding bridge then silently absorbs the difference as a `total_mismatch`. The mixed-order test must show that server totals equal the till's to the minor unit, with no bridge.

## The contract (TallyUI #291, `docs/contract/field-kinds.md` "Amounts")

- **Version 4 is version 3** (the same fields, `display`, `taxByRate` and `sessionId`), except that `lines[].discountMinor` and `payload.discountMinor` are **net**.
- **An exclusive line's discount is unchanged.** An inclusive line's discount D on amount A is sent as `net(A) − net(A − D)`, exact in millionths from the line's `taxLines` and rounded half away from zero per line.
- **`payload.discountMinor = Σ lines[].discountMinor`** still holds exactly, and the vendored `payload-shape.ts` equality check is unchanged.
- **The till sends 4 only to a server whose `/info` advertises 4.** A retry resends the version the order first went out with.

## How Vendure sees a discount today (from the code, 2026-09-30; read before dispatch)

- **Surcharges, not promotions.** The plugin posts each discounted line's discount as its own `TALLY-DISCOUNT` Surcharge carrying the line's `taxLines` (svc:654-663). No Vendure promotions run: `applyPriceAdjustments(ctx, order, [])` (svc:667). The order-level discount is never posted on its own. The till spreads it onto `lines[].discountMinor`, and `payload.discountMinor` must equal their sum (`vendored/payload-shape.ts:53-56`).
- **Vendure rounds each surcharge as its own item.** `Surcharge.price` and `priceWithTax` are each `roundMoney(netPriceOf …)` or `roundMoney(grossPriceOf …)` (`@vendure/core` 3.7.3 `entity/surcharge/surcharge.entity.js:33-38`). The discount is not prorated into the line's `proratedLinePrice`.
- **What that means for the rounding:**
  - Per line (the default strategy): tax is rounded on the line and on its discount separately.
  - Per rate group (order-level): the surcharge joins the line's group by its `taxLines`, and its net is rounded on its own when inclusive.
- **Ruled (#287, Front desk, 2026-09-30): the plugin keeps posting discounts as surcharges.** TallyUI's till rounds the Vendure way. Under the `per_line_items` and `per_rate_group_items` granularities (see `tax-rounding-strategy-info.md`), each undiscounted line and its −D `TALLY-DISCOUNT` are separate items, each rounded half up.
  - The measurement behind the ruling: 4,000 discounted real-Vendure orders, with 0 differences in all four strategy and price-mode cells.
  - **So this PR does not change how discounts are posted.** v4 only changes the surcharge's input: its listPrice is the net D, with `listPriceIncludesTax: false`.
- **Consequence for test 1.** "No bridge" holds only against a till that rounds per item. With a till built before #309, TallyUI's figures still round per order, and a fixture can be bridged for reasons that are not v4's net-versus-gross. That is the stop rule below: pick fixtures where the till's figures and Vendure's agree, and report rather than loosen. Inclusive lines under `per_rate_group_items` keep the `per_order` gap until TallyUI #310.

## In scope

- `packages/vendure-plugin/src/service/constants.ts`: `ORDER_CREATE_VERSIONS` becomes `[1, 2, 3, 4]`, which also advertises it in `/info`.
- `packages/vendure-plugin/src/service/order-create.service.ts`:
  - Every `command.version === 3` becomes `>= 3`: the fiscal-figures check (about svc:347), `tallySessionId` (about svc:593), the per-rate `tax_rate_mismatch` compare (about svc:680) and the `tallySnapshot` (about svc:742). v4 carries v3's fields.
  - **The discount surcharge** (about svc:654-660): for `command.version >= 4`, create the `TALLY-DISCOUNT` surcharge with `listPrice: -line.discountMinor` and **`listPriceIncludesTax: false`**, whatever the line's mode, keeping the line's `taxLines`. Vendure then computes the gross from the line's rate. That is "apply the net discount, converting to gross by that line's rate", with Vendure's own rounding. For v2/v3 the surcharge stays exactly as today, in the line's own mode.
- `packages/vendure-plugin/src/service/strict-shape.ts`: no new fields. Check that a v4 command passes with v3's fields and still refuses unknown ones. Add a comment only if the table needs one.
- `packages/vendure-plugin/test/fixtures/order-create-v4-*.json` (new): **generated by the published till**, not written by hand. Write a script (kept in the job tmp, and named in the PR body) that runs the released `@tallyui/pos` `toOrderCreateEnvelope` capped at 4, and commit its output.
- `packages/vendure-plugin/test/order-create-v4.e2e.ts` (new), and `test/versions.e2e.ts` (its expectations move to `[1, 2, 3, 4]`; its mock-the-vendored-list test keeps proving that the plugin's list rules).
- `docs/adr/0002-order-path-vendure-plugin.md`:
  - §5 "Versions": v4 is accepted, and discounts are net.
  - The field-kinds rows for `discountMinor` (order and line): what the server does per version.
  - The `figures_mismatch` bullet: `discountMinor` becomes comparable from v4 on (still only after TallyUI/tallyui#287; see `tax-rounding-strategy-info.md`).

## Out of scope

- `src/vendored/**`. Vendored copies are never hand-edited. `vendored/commands.ts` types `version: 1 | 2 | 3`, so widen at the use site (`command.version as number`) rather than editing it. If the release publishes `@tallyui/core/server` with #275's split, re-vendoring is its own PR.
- `figures_mismatch` itself, which ships after #287. The subtotal/tax compare stays off, as ADR 0002 §5 says.
- `apps/pos`: the app's `@tallyui` bump is the separate pin PR.

## Tests (`order-create-v4.e2e.ts`)

1. **The mixed order.** Use TallyUI #285's worked examples at the plugin test environment's rate: line a 2 × 12.50 with a 10 % line discount, line b 1 × 9.99, and a 5.00 order discount spread on the lines by the till. The fixtures cover:
   - exclusive (G);
   - inclusive (H);
   - mixed with an inclusive order (I);
   - mixed with an exclusive order.
   For each: `applied`, **no `totalWarnings`** (no `total_mismatch` bridge), and `serverRefs.totalMinor === payload.totalMinor`. The Vendure order's `totalWithTax` equals the till's `totalMinor`, and each `TALLY-DISCOUNT` surcharge's `priceWithTax` equals the till's gross line discount.
   - **Stop rule:** if a fixture is bridged by a rounding difference that is **not** the discount (#38's per-order versus per-group tax rounding), stop and report. Do not loosen the assertion; pick fixtures with one rate group, as #38 measured.
2. **v3 unchanged.** The same inclusive basket sent as v3, with the gross line discount, is applied exactly as today. This guards the `>= 4` branch against leaking into v3.
3. **The version gate.** `/info` advertises `[1, 2, 3, 4]`. A v5 command gets `unsupported_version` with `data { orderCreate: 4 }`.

## Mutation checks (the dispatching session reruns each)

- The v4 surcharge uses the line's mode (`listPriceIncludesTax: line.taxInclusive ?? …`): test 1 fails on H and I with a `total_mismatch`.
- `>= 4` changed to `>= 3` for the surcharge: test 2 fails.
- `ORDER_CREATE_VERSIONS` left at `[1, 2, 3]`: test 3 and every v4 fixture fail with `unsupported_version`.

## Acceptance

From `packages/vendure-plugin`: `npm run build`, `npm run typecheck`, then `npx vitest run test/order-create-v4.e2e.ts test/versions.e2e.ts test/recipe.e2e.ts --maxWorkers=1`, then the full `npx vitest run --maxWorkers=1`. Each after `~/.claude/bin/wait-test-slot.sh`, with `npm run db:up` / `db:down` around them.

## References

TallyUI #286, #291 (v4), #285 (amount definitions), #287 (rounding strategy); vendurepos #38, #53; ADR 0002 §5.
