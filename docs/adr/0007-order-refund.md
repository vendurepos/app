# order.refund in the Vendure plugin: Vendure's own refund, a stock cancellation, figures from the Refund

Status: Proposed (one-way: money, a plugin API change and register figures; merged on the front desk's approval)
Date: 2026-10-07

## Context

TallyUI ADR-080 adds the `order.refund` v1 command (`@tallyui/core` 3.9.1: `OrderRefundPayload`, `refundPayloadErrors`, `OrderRefundResult`, the seven `OrderRefundRejectionCode`s) and gives `deriveSessionFigures` a `refunds` input. The till sends a refund online only and shows success only on `applied`. The Front desk ruled on 2026-10-07:

- the plugin checks its own permission, `TallyPosRefund`, and refuses a till without it `forbidden`;
- only orders the till made (`tallyClientOrderId`) are refunded in v1; others are refused `not_till_order`;
- a refund needs an open session on the refunding register, or it is refused `no_open_session`.

Vendure 3.7.3 does three things the design has to fit:

- `OrderService.refundOrder` moves money only. With `amount` set it refunds that amount against one payment, and it refuses an amount over that payment's remainder (`payment.service.js` `createRefund`). It saves a `RefundLine` per input line and copies `shipping` and `adjustment` onto every Refund it creates.
- A `PaymentMethodHandler` without `createRefund` leaves the Refund `Pending`. Its `createRefund` result is the only place to set the Refund's `metadata`, and a result of `Pending` is refused (`Pending` → `Pending` is not a transition), so a handler that has `createRefund` settles or fails every refund.
- `cancelOrder` with lines restocks fulfilled units through `StockMovementService.createCancellationsForOrderLines` (a `Cancellation`, `stockOnHand` up), and it also lowers each line's `quantity` and recomputes the order's totals.

TallyUI's `vendureRefundable` counts a line's refundable quantity as its current `quantity` less its refund lines over refunds not `Failed`. Refunded shipping is the sum of `Refund.shipping` on the same refunds. Pending refunds count as refunded.

## Decision

1. **Route and permission.** `order.refund` goes through `POST /tally/v1/commands` with the other commands, in array order. The route's `@Allow` is unchanged. The handler refuses `forbidden` unless the request's user holds `TallyPosRefund` in the channel (`ctx.userHasPermissions`). `/info` advertises `contracts['order.refund']: [1]`.
2. **Ledger.** The command id is the idempotency key in `tally_command`, as for the register commands: the shape check (`refundPayloadErrors`, unchanged from `@tallyui/core` 3.9.1) and the version check run before any lookup, then the replay read, the claim and the work, all in one transaction.
   - An applied result is stored and replayed as `duplicate`.
   - A Vendure `ErrorResult` from `refundOrder` is stored as `platform_error`.
   - Every refusal in the contract list is unstored: the transaction, claim included, rolls back. Each one depends on state that changes (a role, a session, the order's other refunds), and a refusal makes no change, so a resend is decided afresh.
3. **Locks.** The register's advisory lock (ADR 0003's `0x7a13` key) comes first, so a refund cannot land in a session whose closure is being submitted. A row lock on the order (`SELECT … FOR UPDATE`) comes second, so two refunds of one order cannot both pass the remainder checks.
4. **Checks, in order.**
   1. `forbidden`.
   2. `no_open_session` (`data: { sessionId }`). It applies when the payload's session (or an alias of it) is unknown, belongs to another register, is closed or superseded, or has its closure. A session that is counting still takes refunds, as it takes movements.
   3. `invalid_payload` (unstored) when the order is not in the channel, or when `clientOrderId` is sent and differs from the order's `tallyClientOrderId`.
   4. `not_till_order` when the order has no `tallyClientOrderId`, or is `tallyRejected`.
   5. `order_state` (`data: { state }`) unless the order is in `PaymentSettled`, `PartiallyShipped`, `Shipped`, `PartiallyDelivered` or `Delivered`.
   6. `invalid_payload` (unstored) when an `orderLineId` is not a line of the order.
   7. `quantity_exceeds`, with `data.lines` listing every line over its refundable quantity. A line's refundable quantity is its `quantity` less its refund lines over refunds not `Failed`, as in `vendureRefundable`.
   8. `nothing_to_refund` when there are no lines and `shippingMinor` and `adjustmentMinor` are both 0.
   9. `amount_mismatch` (`data: { expectedMinor: totalMinor, serverMinor }`) when `shippingMinor` is over the refundable shipping, when the raw amount is outside 0 to the money remainder, or when the server amount differs from `totalMinor`.
      - The raw amount is Σ line share + `shippingMinor` + `adjustmentMinor`. A line's share is its part of the line total, as in WCPOS (Front desk, 2026-10-07): with `N` the line's `quantity`, `T` its `proratedLinePriceWithTax`, `r` the quantity already refunded (refund lines over refunds not `Failed`) and `q` the quantity refunded now, the share is `round((r + q) × T / N) − round(r × T / N)` (half up, as Vendure's `DefaultMoneyStrategy`). So a whole line refunds exactly `T`, and partial refunds of a line add up to `T`. Vendure rounds `proratedUnitPriceWithTax` per unit, so `quantity × proratedUnitPriceWithTax` can miss the line total by cents.
      - The server amount is the raw amount clamped to that range.
      - The money remainder is the sum, over the order's `Settled` `tally-pos` payments, of each payment's amount less its refunds not `Failed`.
   10. `nothing_to_refund` again if the server amount is 0.
5. **Money.** The server amount is split across the order's `Settled` `tally-pos` payments in payment id order, each up to its own remainder. Each share is one `refundOrder({ paymentId, amount: share, reason })`.
   - Only the first call carries `lines` (`orderLineId`, `quantity`) and `shipping: shippingMinor`. The later calls send `lines: []` and `shipping: 0`, so `RefundLine`s and `Refund.shipping` are recorded once and `vendureRefundable` stays right.
   - `adjustment` is never sent; it only feeds the deprecated `Refund.adjustment` field.
6. **createRefund.** The `tally-pos` handler gains `createRefund`, which always returns `Settled`, because the till records the money itself and no provider is called.
   - On the command route, the handler reads a refund context that `RefundService` puts on the RequestContext, the same way as the route mark (a symbol property, which survives `ctx.copy()`). It writes `metadata: { tallyRegisterId, tallySessionId, tallyCashierRef?, tallyDestination, tallyMethod, tallyClientRefundId, tallyLines }`. `tallyLines` is `[{ orderLineId, quantity }]` (the raw Vendure line id) on the first Refund of a command and `[]` on the rest, the same lines `refundOrder` records as `RefundLine`s; it keeps the refunded quantities on the Refund in case Vendure drops `RefundOrderInput.lines` and `shipping`, both deprecated.
   - `tallyMethod` is `cash` for a cash refund. For `original_method` it is the payment's own tender method (`payment.metadata.tender.method`).
   - Elsewhere (an admin refund of a POS order) the handler returns `Settled` with no till metadata. Before this change such a refund stayed `Pending` until an admin settled it by hand; it now settles at once, as with Vendure's other manual handlers, and it counts in no register session.
7. **Restock.** A line with `restock: true` is restocked by `StockMovementService.createCancellationsForOrderLines`, for at most its fulfilled quantity less its existing cancellations (Vendure's own cap in `cancelOrderByOrderLines`). This is the `Cancellation` movement `cancelOrder` makes. The plugin does not call `cancelOrder`: that would lower the line's `quantity`, and `vendureRefundable` would then count those units twice. The sale's stock top-ups were taken back inside the sale's own transaction (ADR 0002 "Stock"), so a restock returns sold units only and double-counts nothing.
8. **Result.** `applied` with `refund: { totalMinor, byMethod, refunds: [{ id, paymentId, totalMinor, state }] }`, where `byMethod` sums `totalMinor` by `tallyMethod`.
9. **Register figures.** A refund counts in the session in its metadata (the session that made it), whatever session the sale was in. The session's live figures and its closure's `expected` pass `deriveSessionFigures` (`@tallyui/core` 3.9.1) one `{ byMethod: { [tallyMethod]: total } }` per Refund that is not `Failed` and carries that session's id. So expected cash falls by cash refunds, and each original-method refund lowers its own method. The counters' `perpetualRefundsTotalMinor` is the last closure's, like `perpetualSalesTotalMinor`; it is no longer 0. The register contract version is unchanged: TallyUI 3.9.1 still lists register `[1]` with refunds in the figures.

## Consequences

- A till refund is a normal Vendure Refund. It shows on the order in the admin with its reason and the till's metadata, and an admin's later `cancelOrder` of the same lines restocks nothing twice, because Vendure subtracts existing cancellations.
- Refunds made from the admin, or by any other client, carry no session and never touch a register's figures.
- Storefront orders stay out until a ruling brings them in. Their payment handler, not the till, owns their refund.
- No migration: the session attribution lives in `Refund.metadata`.
- The till must compute `totalMinor` by the same line-share rule. TallyUI's `vendureRefundable` (`@tallyui/connector-vendure` 3.9.x) offers a per-unit `unitRefundWithTax`, and ADR-080 has the till sum `proratedUnitPriceWithTax`, so the till side changes in TallyUI before the app's refund flow ships; until then a whole-line refund of a line whose total is not a whole multiple of its unit price is refused `amount_mismatch`.
