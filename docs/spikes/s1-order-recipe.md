# Spike S1: the Vendure order recipe (ADR 0002)

Status: complete. All 12 proofs pass (63 tests). Tightened after the judge-only review; ADR 0002 stays Proposed until a clean re-review
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

Codex wrote groups A–D, one spec per proof group. Codex's quota ran out
before group E, so under the exit-5 rule an Opus subagent implemented it
from the same, unchanged spec. Every number below comes from the
worker's own run of the full suite, not from the implementer's.

## Results

| # | Claim (ADR 0002) | Result | Numbers | Evidence |
|---|---|---|---|---|
| 1 | Tax parity: discount surcharges plus one rounding bridge match the till | **PASS** | 16 cases across the default and `OrderLevelTaxCalculationStrategy`: tax-exclusive and tax-inclusive × discounted, mixed-mode and negative-tie, plus a v2 discount and a negative control. Every total = `totalMinor`, and **the bridge is asserted ≤ B = ⌈(lines + surcharges)/2⌉ in every parity case**. The only non-zero bridge is **1** (B = 3, order-level strategy, inclusive, mixed). The largest per-rate difference is **1** (default strategy, inclusive, mixed, 7 %, T = 2). **Negative control:** a POS total deliberately off by B + 5 = 6 is applied with a bridge of 6, and the bound assertion is shown to throw on it. A deliberately misallocated `taxByRate` gives two `tax_rate_mismatch` warnings (19 %: 24 vs 19; 7 %: 2 vs 7), and the sale is still applied. **Rounding:** Vendure rounds surcharge tax with `Math.round` (−59.5 → −59), and the bridge and tolerance absorb that; the plugin's own half-away-from-zero rounding applies only to the figures it computes (T, the bridge). Front desk ruling; ADR amended. The POS figures come from TallyUI's vendored exact maths, independently of Vendure | `test/tax-default.e2e.ts`, `test/tax-order-level.e2e.ts`, `test/tax-cases.ts` |
| 2 | No server promotions on POS orders | **PASS** | An automatic order-percentage promotion and a line fixed-discount promotion were both active. Each was applied by the re-pricing calls the recipe makes (every `addItemToOrder`, then `setShippingMethod`), and was still present after the surcharge save, which does not re-price. `order.promotions`, `order.discounts` and every line's adjustments are empty after the final `applyPriceAdjustments(ctx, order, [])`, after the payments, and after the order is reloaded post-fulfilment. The recipe avoids `addSurchargeToOrder` and `addPaymentToOrder` altogether: it saves surcharges through the repository and uses `PaymentService.createPayment`. Those two calls are avoided, not neutralised | `test/promotions.e2e.ts` |
| 3 | No customer email for POS orders | **PASS** | `EmailPlugin`'s `orderConfirmationHandler` is filtered on `tallyClientOrderId`. The POS order sends **0** emails, and the control Shop API order sends **1** ("Order confirmation for #…"). The handler fires on `OrderStateTransitionEvent` (to `PaymentSettled`), not `OrderPlacedEvent`. **Limits:** the filter lives in the test's `EmailPlugin` configuration (the plugin will export it as a wrapped handler, per the Front desk's ruling); only `orderConfirmationHandler` is covered; the testing transport skips the job queue | `test/email.e2e.ts` |
| 4 | Storefront cannot use `tally-pos` or the in-store method | **PASS** | On a Shop API guest order, `tally-pos` is listed with `isEligible: false`, and `addPaymentToOrder` gives `INELIGIBLE_PAYMENT_METHOD_ERROR` (the order stays in `ArrangingPayment` with no payment). `tally-in-store` is missing from the eligible shipping methods, and `setOrderShippingMethod` gives `INELIGIBLE_SHIPPING_METHOD_ERROR`. **The handler guard also holds on its own:** with a forged `tallyClientOrderId` that makes the checker pass, the payment is `Declined` ("only available to the POS route") because `ctx.apiType` is not `custom` | `test/storefront.e2e.ts` |
| 5 | A returned `ErrorResult` rolls the whole order back | **PASS** | An underpaid sale (875 due, 500 paid) with a discount and a new buyer email, so the transaction first writes a surcharge and a customer, makes `transitionToState('PaymentSettled')` return `OrderStateTransitionError`. Every table is unchanged afterwards: orders 6, lines 10, payments 6, stock movements 24, surcharges 0, shipping lines 6, order history 48, customers 1. The only change is one stored `rejected` ledger row (6 → 7). Only this `ErrorResult` type and the stock rollback (proof 7) are exercised. The spike stores Vendure's own code; the contract mapping (`underpaid`, and unknown ones with the Vendure code in `data`) is the Front desk's ruling for VP1 | `test/recipe.e2e.ts` |
| 6 | One transaction per command in a batch | **PASS** | A batch of 3 whose 2nd command uses a disabled variant gives applied / stored `unknown_variant` / applied. A batch whose 2nd command meets a held lock answers 409 after **5.6 s**: the 1st command is committed and the 3rd is not processed. The retry answers `duplicate`, `duplicate`, `applied` | `test/ledger.e2e.ts` |
| 7 | Stock top-up before `addItem`, never cut, taken back | **PASS** | Selling 3 × `Print` with 2 on hand: stock goes 2 → **3** after the top-up (before any item is added), then 0 after fulfilment, then **−1** after the take-back. The order line keeps quantity **3**, and there is an `insufficient_stock` warning with `quantity: 1`. Movements: ADJUSTMENT +1, ALLOCATION 3, SALE −3, ADJUSTMENT −1. **Control without the top-up:** `addItemToOrder` saves the line at 2 and returns `InsufficientStockError`, which the recipe would turn into a rejection; `addItemsToOrder` silently cuts the line to 2. **Rollback:** a sale that tops up and then fails leaves stock and movements unchanged | `test/stock.e2e.ts` |
| 8 | POS lines stay 1:1 | **PASS** | Two POS lines of the same variant become 2 order lines, each with its own `tallyClientLineId` | `test/recipe.e2e.ts` |
| 9 | Split tender, overpayment, zero total | **PASS** | Split tender: payments 500 + 500 = 1000. Overpayment: a cash tender of 2000 on a 1000 total gives one payment row of 1000, and `tallyPayments` keeps tendered 2000 and change 1000. Zero total: `Draft → ArrangingPayment → PaymentSettled → Delivered` with no payment row | `test/recipe.e2e.ts` |
| 10 | Stored rejections, no retry loops | **PASS** | A disabled variant and a missing variant each give a stored `unknown_variant` with no new order; replays return it in 13–25 ms without running the recipe. A channel whose default-zone tax rates are all disabled (the nearest Vendure 3.7.3 equivalent of "no tax zone") gives `store_configuration` with no ledger row and no order. There are no 503s | `test/ledger.e2e.ts` |
| 11 | Idempotency under concurrency | **PASS** | (a) The first request holds its transaction for 2 s: the second waits about 2.5 s and gets `duplicate`, and there is 1 order. (b) The first holds for 7 s: the second gets 409 at **5.04 s**, and a retry after the commit gets `duplicate` in 32 ms; 1 order. (c) A new command id for an existing `clientOrderId` returns that order's refs as `applied` (following medusapos) and writes nothing (counts unchanged). (d) The same id with a different payload gives `idempotency_mismatch` and writes nothing | `test/ledger.e2e.ts` |
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
6. **The confirmation email's event.** In 3.7.3, `orderConfirmationHandler`
   listens to `OrderStateTransitionEvent` (to `PaymentSettled`), not
   `OrderPlacedEvent`. The filter on `tallyClientOrderId` works on that
   event. ADR 0002's wording is corrected.
7. **`addItemToOrder` rejects rather than cuts.** On a shortage it saves
   the line at the saleable quantity and returns `InsufficientStockError`.
   Only the plural `addItemsToOrder` cuts silently. Either way the top-up
   must come first. ADR 0002's wording is corrected.
8. **Negative stock is allowed.** Vendure accepts on-hand stock of −1
   after a take-back. That is the honest record of an oversold, paid
   sale.
9. **The top-up uses the default stock location.** With one location that
   is the same one `StockLocationStrategy` allocates from. With several,
   VP3 must ask the strategy, and no order line exists yet at top-up time.
   Left open.
10. **The email job queue was not exercised.** With the `testing`
    transport, `EmailPlugin` sends in-process and skips the `send-email`
    queue. The filter decides before anything would be queued, so a real
    transport should behave the same, but that path was not run.
11. **`codex-job.sh` reports exit 1, not 5, on a Codex usage limit.** The
   quota message appears only in `events.jsonl`. Reported to the Front
   desk.

## Found by the judge-only review (not proven by S1; follow-ups for VP1–VP3)

- **Error classification.** The spike stores every `ErrorResult` under
  Vendure's own code, and turns every other exception into a 503, so a
  deterministic exception could loop. The Front desk's ruling for VP1:
  - known `ErrorResult`s map to contract codes (`underpaid` only when the
    payments really are short);
  - unknown ones are stored rejections, with the Vendure code in `data`;
  - a unique violation on `tallyClientOrderId` takes the requeue path;
  - 503 is kept only for connection, lock and timeout failures.
  ADR amended.
- **`unsupported_currency`** is not implemented in the spike, which takes
  `currencyCode` from the payload unchecked. VP1 adds it as a pre-claim,
  unstored check.
- **Concurrent sales of one variant.** Vendure's stock update is an
  unlocked read-modify-write (`stock-level.service.js`), and the top-up and
  take-back double that exposure. VP3 should measure it.
- **Split tender with change on a non-final tender** is untested. The
  payment loop stops once the total is covered.
- **The handler guard** checks `ctx.apiType === 'custom'`, which holds for
  any plugin's REST controller, not only this route.

## How to rerun

```sh
cd spikes/s1-order-recipe
npm ci
npm run db:up        # Postgres 16 on 127.0.0.1:5444, project vendurepos-s1
npm test             # vitest, one worker
npm run db:down      # removes the container and its volume
```
