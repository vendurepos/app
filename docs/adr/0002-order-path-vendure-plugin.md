# The order path: `order.create` v3 as one transaction in a Vendure plugin

Status: Proposed
Date: 2026-09-29

## Context

A POS sale is recorded offline first and reaches the server later as a
TallyUI command. The client side is already built and platform-neutral:

- **The contract.** `order.create` is sent to `POST /tally/v1/commands`
  (`X-Tally-Protocol: 1`, 1–50 commands per batch). The command `id` is a
  UUIDv7 and is the idempotency key. The server fingerprints the canonical
  `{type, version, payload}` with SHA-256 (TallyUI ADR-038, ADR-039).
- **The results.** Each command comes back `applied`, `duplicate` or
  `rejected`, with `serverRefs` of `orderId`, `displayId` and `totalMinor`.
  The error codes are those of ADR-038/039 (`idempotency_mismatch`,
  `unknown_variant`, `underpaid`, `insufficient_stock`, `invalid_payload`,
  `store_configuration`, `unsupported_version`, …), plus the `total_mismatch`
  warning, HTTP 409 `in_progress` and 503 for a transient failure.
- **Versions.** v2 adds pre-tax discounts (ADR-062). v3 adds the frozen
  `display` and `taxByRate` receipt snapshots, the register `sessionId` and a
  soft `customer.customerId` (ADR-065). The server advertises what it
  accepts with `GET /tally/v1/info` (`{"contracts":{"order.create":[…]}}`).
  The outbox falls back to a lower version with the **same** command id when
  the server refuses a version (ADR-062, ADR-065).
- **The outbox.** It retries with backoff and honours `Retry-After`. A 409
  retries the batch; three 401s in a row pause it for sign-in. A rejected
  order is kept as a dead letter that the user can requeue under a new id
  (TallyUI `packages/pos/src/outbox`).

TallyUI has already sketched the Vendure side: Admin API only for reads, a
plugin for the write, and one database transaction (ADR-046, ADR-047). Tax
parity comes from a rounding surcharge rather than a change to the
merchant's configuration (ADR-048). None of it is built, and spike S1 in
the plan has not yet proved the recipe.

The principle for this decision is Paul's (TallyUI ADR-067, 2026-09-28):
**"the engine's mechanics are the input, its constraints are not."** In his
words: "The WCPOS sync engine and core may be limited by PHP or server
considerations that do not apply to Medusa or Vendure." So we adopt
Vendure's own mechanics wherever they do the job, and we do not carry over
workarounds that exist only because of WooCommerce, PHP or Medusa.

## Decision

### 1. A Vendure plugin, not the Admin API alone

The write goes through a server plugin (`@vendurepos/plugin`, in
`packages/vendure-plugin`). The Admin API cannot express a POS sale:

- it has no as-sold line price, no payment amount, no back-dating and no
  idempotency;
- a sale would take a dozen separate mutations, so a crash half-way through
  leaves a half-built order that the client would have to find and repair.

A plugin can call `OrderService`, `PaymentService` and
`StockMovementService` inside **one `TransactionalConnection` transaction**.
That is the Vendure mechanic that makes the rest simple. The plugin
registers a Nest controller for `POST /tally/v1/commands` and
`GET /tally/v1/info`, behind Vendure's own auth. Authentication is the same
bearer token (or API key) the app already uses, and the channel is chosen by
`vendure-token`. The permission is `@Allow(Permission.CreateOrder)` for the
MVP, and a custom `TallyPosSell` permission later.

### 2. Idempotency: the ledger row commits or rolls back with the order

A `TallyCommand` entity (command id as primary key, fingerprint, status,
result JSON) is claimed **inside the same transaction as the order**:

- `INSERT … ON CONFLICT DO NOTHING` on the id. A second request for the same
  id blocks on the uncommitted row. After a 5 s `lock_timeout` it answers
  409 `in_progress`, which the outbox already retries.
- Once the first request commits, a replay reads the stored result
  (`duplicate`, same `serverRefs`). A different fingerprint gives
  `idempotency_mismatch`.
- If the first request fails, the ledger row rolls back with the order, so
  a retry starts clean.
- `Order.tallyClientOrderId` has a unique index as a second guard.

This **replaces** medusapos's 120 s claim lease, its fencing token, the
advisory lock and the compensation/resume code (about 600 of its 988
lines). Those exist because Medusa workflows and WooCommerce's PHP requests
cannot put the whole sale in one transaction. Vendure can.

`invalid_payload`, `store_configuration` and `unsupported_version` are
decided **before** the claim, so nothing is written for them.

### 3. A POS sale is a Vendure Order

| POS concept | Vendure mechanism (adopted) | Replaces (not carried over) |
|---|---|---|
| The sale | A draft `Order` in the request's channel, moved through Vendure's own order process: `AddingItems → ArrangingPayment → PaymentSettled`, then fulfilled | WooCommerce statuses and WCPOS's `pos-open`/`pos-partial` states; a sale that reaches the server is always paid |
| As-sold price | An `OrderItemPriceCalculationStrategy` that wraps the configured one and, only on orders with `tallyClientOrderId`, uses the read-only line custom field `tallyUnitPrice` | Rewriting line totals through post meta |
| Discounts (v2/v3) | A pre-tax discount per line, carried into the order as Vendure price adjustments. The mechanism is spike S1's first question (see Consequences) | — |
| Tax | The channel's `pricesIncludeTax`, its default tax zone and the merchant's tax strategy, unchanged. Any difference is settled by the ADR-048 surcharge (`TALLY-ROUNDING`, with a `total_mismatch` warning) | WooCommerce's single "prices include tax" option, and changing store settings to match the POS |
| Payment | A `tally-pos` `PaymentMethodHandler`: one settled `Payment` per tender (`cash` or `external`), with tendered, change and reference in its metadata. The payments cover exactly `totalMinor` (ADR-039), and split tender works natively | Payment-gateway emulation and gateway meta |
| Collection | An in-store `ShippingMethod` whose eligibility checker accepts only POS orders, with a zero calculator | Hiding shipping lines |
| Stock | A manual fulfilment, which records `SALE` stock movements. For `insufficient_stock`, the paid sale is still applied: a temporary top-up and take-back inside the transaction, plus a warning (ADR-039) | WooCommerce stock-reduction hooks and reservation tables |
| Customer | Existing customer by `customer.customerId` (v3) or email; otherwise one walk-in placeholder customer per channel | Guest-order meta |
| Register and cashier | Order custom fields: `tallyRegisterId` (the drawer, not the device), `tallySessionId` (v3), `tallyCashierRef`, `tallyDeviceId` and `tallySaleAt` (the sale time, since `orderPlacedAt` is the sync time). Register sessions, movements and closures become their own commands and entities later (ADR-068); the order only references them | `_wcpos_register`, `_wcpos_session` and `_pos_user` post meta; the WooCommerce sale counter, which TallyUI's payload does not carry and this plugin does not add |
| Receipt snapshot (v3) | `display` and `taxByRate` are stored unchanged in a read-only `Order.tallySnapshot` text field, so the order carries the receipt exactly as the cashier printed it | Rebuilding a receipt from server totals |
| Order number | Vendure's own order `code`, returned as `serverRefs.displayId` | — |

The custom fields are typed and indexed (`tallyClientOrderId` is unique),
and they are read-only in the Admin API, so only the plugin writes them.

### 4. What stays in TallyUI, unchanged

The command envelope and its UUIDv7 id, the fingerprint rule and the
result/error vocabulary are all TallyUI's. So are:

- the durable outbox: retry, `Retry-After`, 409, the pause after repeated
  401s, dead letters, requeue, and the version fallback;
- capability discovery and the exact integer tax maths (ADR-037);
- the local `PosOrder` with its frozen fiscal snapshots, and register
  sessions (ADR-032, ADR-068).

The plugin is a server for that contract. It adds nothing to the client.

### 5. Versions

The plugin advertises `{"contracts":{"order.create":[1,2,3]}}` from its
first release, because v3 is what TallyUI `main` sends:

- v1 and v2 are accepted for older clients;
- a higher version gets `unsupported_version` with `data.orderCreate: 3`
  before the claim;
- v1 and v2 orders simply have no snapshot or session id.

## Consequences

- **Spike S1 comes first.** It proves the recipe on vendure-dev in one
  transaction: the read-only `tallyUnitPrice` written from the plugin, the
  settled `tally-pos` payment, `SALE` movements, rollback on a thrown error,
  and the surcharge. Its first new question is **discounts**:
  - either as a price adjustment on the line, through the price strategy
    with the unit price net of discount and the remainder in the surcharge;
  - or as negative `Surcharge`s that carry the line's tax rate.

  Whichever keeps Vendure's tax lines right wins. ADR-062 requires this
  answer. Server-side promotions still run on POS orders; any change they
  make to the total is settled by the surcharge and reported as
  `total_mismatch`, rather than being disabled.
- The plugin is smaller than medusapos's, because the transaction removes
  the lease, lock and resume code. The ADR-051 KPI is still measured, not
  assumed.
- **The app cannot send v3 yet.** The published `@tallyui/*` 2.0.0 types
  know only command versions 1 and 2, so v3 waits for the next TallyUI 2.x
  publish. The plugin accepts all three, so nothing blocks on it.
- A Vendure 3.8 change to draft orders or the order process would land in
  one plugin file. `compatibility: '^3.6.0'` stays until it is tested.
- Distribution (npm scope, trusted publishing) follows the plan's ADR-054
  and is not decided here.
