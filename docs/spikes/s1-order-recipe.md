# Spike S1: the Vendure order recipe (ADR 0002)

Status: in progress (proofs 3, 4 and 7 pending)
Date: 2026-09-29
Branch: `spike-s1`. Code: `spikes/s1-order-recipe/` (TEMPORARY, evidence only)

## What was tested

ADR 0002 (`docs/adr/0002-order-path-vendure-plugin.md`) records
`order.create` v3 as one transaction per command in a Vendure plugin. Its
Consequences list twelve proofs that must hold before the ADR moves from
Proposed to Accepted.

The spike tests them against a minimal plugin in `spikes/s1-order-recipe`.
It runs on Vendure 3.7.3 and Postgres 16 through `@vendure/testing`, with
real HTTP requests to `POST /tally/v1/commands`. The contract code
(payload shape, fiscal figures, fingerprint, money, versions, and
TallyUI's exact tax maths and v3 types) is vendored, marked TEMPORARY,
from medusapos 5c23a74 and TallyUI `origin/main` until
`@tallyui/core/server` exists.

Codex wrote the code from one spec per proof group. Group E fell to an
Opus subagent under the exit-5 rule. Every number below comes from the
worker's own run of the full suite, not from the implementer's.

## Results

| # | Claim (ADR 0002) | Result | Numbers | Evidence |
|---|---|---|---|---|
| 1 | Tax parity: discount surcharges plus one rounding bridge match the till | **PASS** | 12 cases (default and `OrderLevelTaxCalculationStrategy` × tax-exclusive and tax-inclusive × discounted, mixed-mode and negative-tie orders). Every order total = `totalMinor`. The largest per-rate difference is **1** minor unit (default strategy, inclusive, mixed, 7 %, where T = 2). The largest bridge is **1** (order-level strategy, inclusive, mixed). A deliberately misallocated `taxByRate` gives two `tax_rate_mismatch` warnings (19 %: 24 vs 19; 7 %: 2 vs 7), and the sale is still applied | `test/tax-default.e2e.ts`, `test/tax-order-level.e2e.ts`, `test/tax-cases.ts` |
| 2 | No server promotions on POS orders | **PASS** | An automatic order-percentage promotion and a line fixed-discount promotion were both active. Each was applied after every `addItemToOrder`, after `setShippingMethod` and after the surcharge save. `order.promotions`, `order.discounts` and every line's adjustments are empty after the final `applyPriceAdjustments(ctx, order, [])`, after the payments, and after the order is reloaded post-fulfilment. The recipe never calls `addPaymentToOrder`; it uses `PaymentService.createPayment` | `test/promotions.e2e.ts` |
| 3 | No customer email for POS orders | pending | | |
| 4 | Storefront cannot use `tally-pos` or the in-store method | pending | | |
| 5 | A returned `ErrorResult` rolls the whole order back | **PASS** | An underpaid sale makes the recipe's `transitionToState('PaymentSettled')` return `OrderStateTransitionError`. Afterwards, orders 6→6, order lines 10→10, payments 6→6 and stock movements 24→24 are unchanged, and ledger rows go 6→7: one stored `rejected` row, per §2 | `test/recipe.e2e.ts` |
| 6 | One transaction per command in a batch | **PASS** | A batch of 3 whose 2nd command uses a disabled variant gives applied / stored `unknown_variant` / applied. A batch whose 2nd command meets a held lock answers 409 after **5.6 s**: the 1st command is committed and the 3rd is not processed. The retry answers `duplicate`, `duplicate`, `applied` | `test/ledger.e2e.ts` |
| 7 | Stock top-up before `addItem`, never cut, taken back | pending | | |
| 8 | POS lines stay 1:1 | **PASS** | Two POS lines of the same variant become 2 order lines, each with its own `tallyClientLineId` | `test/recipe.e2e.ts` |
| 9 | Split tender, overpayment, zero total | **PASS** | Split tender: payments 500 + 500 = 1000. Overpayment: a cash tender of 2000 on a 1000 total gives one payment row of 1000, and `tallyPayments` keeps tendered 2000 and change 1000. Zero total: `Draft → ArrangingPayment → PaymentSettled → Delivered` with no payment row | `test/recipe.e2e.ts` |
| 10 | Stored rejections, no retry loops | **PASS** | A disabled variant and a missing variant each give a stored `unknown_variant` with no new order; replays return it in 13–25 ms without running the recipe. A channel whose default-zone tax rates are all disabled (the nearest Vendure 3.7.3 equivalent of "no tax zone") gives `store_configuration` with no ledger row and no order. There are no 503s | `test/ledger.e2e.ts` |
| 11 | Idempotency under concurrency | **PASS** | (a) The first request holds its transaction for 2 s: the second waits about 2.5 s and gets `duplicate`, and there is 1 order. (b) The first holds for 7 s: the second gets 409 at **5.04 s**, and a retry after the commit gets `duplicate` in 32 ms; 1 order. (c) A new command id for an existing `clientOrderId` returns that order's refs and writes nothing (counts unchanged). (d) The same id with a different payload gives `idempotency_mismatch` and writes nothing | `test/ledger.e2e.ts` |
| 12 | A crash after commit leaves no duplicate | **PASS** | The request commits and then throws before responding (500). The retry returns `duplicate` with the same `orderId`, and there is exactly 1 order | `test/ledger.e2e.ts` |

Also measured on the happy path: a Mug × 1 plus Beans × 2 sale (total
2250) ends `Delivered`. Stock drops 10→9 and 10→8, with `SALE` movements
of −1 and −2. `orderPlacedAt` equals `tallySaleAt`, and every custom field
is written by the plugin despite being read-only in the API.

**Per-line tax mode works.** An inclusive line priced 1000 gets
`unitPrice` 800 and `unitPriceWithTax` 1000, beside exclusive lines of
500 → 625 and 900 → 1125. The strategy reads it from a read-only OrderLine
field, `tallyPriceIncludesTax`.

## Findings for the plugin (VP1–VP5)

1. **Vendure rewrites exception bodies.** Its global
   `ExceptionLoggerFilter` turns every thrown `HttpException` into
   `{ statusCode, message, timestamp, path }`, which loses `code` and `id`.
   The 409 `{ code: 'in_progress', id }` and 503
   `{ code: 'transient', id, message }` bodies must therefore be written
   through the Express response (`@Res({ passthrough: true })`), not
   thrown. The Front desk ruled this into ADR 0002.
2. **Per-line tax mode needs a field.** It uses a read-only OrderLine
   custom field (`tallyPriceIncludesTax`), because the price strategy only
   sees the order and the line's custom fields.
3. **`DefaultOrderItemPriceCalculationStrategy` is not exported** from
   `@vendure/core`'s index in 3.7.3. The wrapper imports it by its
   `dist/config/order/…` path, or falls back to the variant's list price,
   which is all the default does.
4. **"No tax zone" has no direct equivalent on 3.7.3.** A channel keeps a
   default tax zone, so the reachable configuration hole is a default zone
   whose rates are all disabled.
5. **The warning contract grows, additively** (Front desk ruling):
   - `total_mismatch` gains `bridgeMinor`, which is signed and present if
     and only if a bridge was added;
   - a new `tax_rate_mismatch` warning `{ ratePpm, expectedMinor, serverMinor }`
     is emitted per rate above T;
   - the till ignores warning codes it does not know.

   The spike emits both today. TallyUI adds them to its core types and
   server package for 2.2.0, and the exact shapes have been sent to the
   TallyUI worker.
6. **`codex-job.sh` reports exit 1, not 5, on a Codex usage limit.** The
   quota message appears only in `events.jsonl`. Reported to the Front
   desk.

## How to rerun

```sh
cd spikes/s1-order-recipe
npm ci
npm run db:up        # Postgres 16 on 127.0.0.1:5444, project vendurepos-s1
npm test             # vitest, one worker
npm run db:down      # removes the container and its volume
```
