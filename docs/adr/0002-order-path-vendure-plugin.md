# The order path: `order.create` v3 as one transaction per command in a Vendure plugin

Status: Accepted (2026-09-29, on spike S1's results: `docs/spikes/s1-order-recipe.md`)
Date: 2026-09-29

## Context

A POS sale is recorded offline first and reaches the server later as a
TallyUI command. The client side is already built and platform-neutral:

- **The contract.** `order.create` is sent to `POST /tally/v1/commands`
  (`X-Tally-Protocol: 1`, 1–50 commands per batch). A batch of more than 50
  answers 413 `{ code: 'batch_too_large', maxCommands: 50, message }`, as
  medusapos does, while an empty or malformed batch stays 400
  `invalid_payload` (Front desk ruling 18, 2026-09-30). A body over the
  route's 1 MiB limit answers 413 `{ code: 'body_too_large', maxBytes:
  1048576, message: 'The request body exceeds 1048576 bytes' }`, with or
  without `Content-Length`. One constant sets both the parser's limit and
  `maxBytes`. The answer is never `invalid_payload`, because a size limit is not
  order-specific; other unparseable bodies stay 4xx `invalid_payload` (Front
  desk ruling 20, 2026-09-30). The command `id` is a
  UUIDv7 and is the idempotency key. The server fingerprints the canonical
  `{type, version, payload}` with SHA-256 (TallyUI ADR-038, ADR-039).
- **The results.** Each command comes back `applied`, `duplicate` or
  `rejected`, with `serverRefs` of `orderId`, `displayId` and `totalMinor`.
  The error codes are those of ADR-038/039 (`idempotency_mismatch`,
  `unknown_variant`, `underpaid`, `unsupported_currency`,
  `insufficient_stock`, `invalid_payload`, `store_configuration`,
  `unsupported_version`, …). Warnings such as `total_mismatch` come back in
  `totalWarnings`. HTTP 409 `in_progress` stops the batch; 503 means a
  transient failure.
- **Versions.** v2 adds pre-tax discounts, allocated per line in each
  line's own tax mode (ADR-062). v3 adds the frozen `display` and
  `taxByRate` receipt snapshots, the register `sessionId` and a soft
  `customer.customerId` (ADR-065). The server advertises what it accepts
  with `GET /tally/v1/info`. The outbox falls back to a lower version with
  the **same** command id when the server refuses a version.
- **The outbox.** It retries with backoff and honours `Retry-After`. A 409
  retries the batch, and earlier members then replay as `duplicate`. Three
  401s in a row pause it for sign-in. A rejected order is kept as a dead
  letter that the user can requeue under a new id. This command outbox is
  temporary: TallyUI moves to the WCPOS sync engine's mutation queue
  (ADR-067 decision 7).

TallyUI has already sketched the Vendure side: Admin API only for reads, a
plugin for the write, and one database transaction (ADR-046, ADR-047). Tax
parity comes from one rounding surcharge rather than a change to the
merchant's configuration (ADR-048). medusapos has built the same contract
on Medusa (its plugin's `process.ts`, `execute.ts`, the ledger, and its
ADRs 0012, 0017, 0019 and 0020). None of the Vendure side is built, and
spike S1 has not yet proved the recipe.

The principle for this decision is Paul's (TallyUI ADR-067, 2026-09-28):
**"the engine's mechanics are the input, its constraints are not."** In his
words: "The WCPOS sync engine and core may be limited by PHP or server
considerations that do not apply to Medusa or Vendure." So we adopt
Vendure's own mechanics wherever they do the job, and we do not carry over
workarounds that exist only because another engine could not do the same.

## Decision

### 1. A Vendure plugin, not the Admin API alone

The write goes through a server plugin (`@vendurepos/plugin`, in
`packages/vendure-plugin`). The Admin API cannot express a POS sale:

- it has no as-sold line price, no payment amount, no back-dating and no
  idempotency;
- a sale would take a dozen separate mutations, so a crash half-way through
  leaves a half-built order that the client would have to find and repair.

A plugin calls `OrderService`, `PaymentService`, `CustomerService` and
`StockMovementService` inside one `TransactionalConnection` transaction per
command. Service calls reuse the request context's query runner, so they
join that transaction.

The plugin registers a Nest controller for `POST /tally/v1/commands` and
`GET /tally/v1/info`, behind Vendure's own auth. Authentication is the same
bearer token (or API key) the app already uses, and the channel is chosen by
`vendure-token`. The permission is `@Allow(Permission.CreateOrder)` for the
MVP, and a custom `TallyPosSell` permission later.

Those services do not check permissions themselves. So `CreateOrder` on this
route also lets the caller fulfil orders, move stock and create customers,
within the recipe. That is accepted for the MVP, and it is the reason for
`TallyPosSell`.

**Postgres only.** The claim below relies on Postgres semantics
(`INSERT … ON CONFLICT` waiting on an uncommitted row, and
`SET LOCAL lock_timeout`). The plugin supports Postgres only, and says so
in its README.

**Shared contract code.** The payload shape, fiscal figures, fingerprint,
money helpers, `validateBatch`, the version rules, `totalWarnings` and the
command result are not rewritten here. They move from medusapos into a
TallyUI server-side package, `@tallyui/core/server`; that is a queued
TallyUI job, and later the register validators and the expected-cash
derivation follow. Spike S1 uses a vendored copy of the medusapos files,
marked temporary. The plugin's first PR after S1 consumes the package.

**Vendored with local changes.** Vendored copies are never changed by hand
(Front desk, 2026-09-30); a needed divergence goes through a core change
instead. `vendored/payload-shape.ts` is copied from medusapos@8667f71
(`packages/medusa-plugin/src/workflows/tally-order-create/payload-shape.ts`),
not from TallyUI core. Apart from its one-line provenance header, it differs
from that source in two places. Both predate the rule, and each keeps the
vendored shape stage free of a length check that this server runs in step 4,
after the replay read, so a stored answer always wins:

- **`customer.customerId`:** the `≤ 64` length check is removed from the
  shape check (`d7a443e`, VP2a). The removal was made for the VP2a ruling
  that an over-long id is ignored. Since vendurepos/app#45 the length is
  refused in step 4 instead (`service/value-ranges.ts`), in the order the
  Front desk ruled on the TallyUI #222 review.
  - **Stale comment:** the frozen file still says "over 64 is ignored by the
    recipe (customer_ignored), never refused here". The first half is out of
    date: an id over 64 characters is refused as `invalid_payload` in step 4.
    Only "never refused here", at the shape stage, still holds.
- **`sessionId`:** the `≤ 36` length check is removed from the shape check
  (`21a45c5`, VP3-1), in the order the Front desk ruled on the TallyUI #222
  review. It is refused in step 4 (`service/value-ranges.ts`).

`vendored/versions.ts` is vendored verbatim and deliberately unread since
vendurepos/app#53. Its header comment ("/info advertises them and
processBatch enforces them (one source)") is out of date: `/info` and the
gate read the plugin's own `ORDER_CREATE_VERSIONS` (`service/constants.ts`).

The medusapos file is the origin: core's shape check was lifted from it
(TallyUI `898e98b`), and core now holds the canonical copy, so that is where
the checks should split. TallyUI/tallyui#275 asks core to expose its
structure and value-range checks separately. Once it lands, the next
vendoring takes the file verbatim from `@tallyui/core/server` rather than
medusapos, and calls the two parts at this server's own stages.

### 2. Transactions, idempotency and error classes

**One transaction per command, never per batch.** The controller has no
`@Transaction()`:

1. It first validates every envelope in the batch (`validateBatch`).
2. Each command then goes through exactly these steps (ADR-038 #220):
   1. **shape validation**: types, presence, versions and U+0000 in any
      string (which Postgres cannot hold, even for the lookup), with no
      database access: `invalid_payload` or `unsupported_version`, not
      stored. The deliberate exceptions are the envelope `id` bound (≤ 64), because the id is
      the replay key itself, so no stored row can have a longer id and a replay can
      never be refused by this bound; the duplicate-`clientLineId` refusal, because
      the till mints a UUIDv7 per line, so no applied command carries a duplicate;
      and the vendored discount value checks (each `discountMinor`, when present, is a positive
      safe integer, and the order's `discountMinor` equals the sum of the lines'),
      because these have not tightened since any command was applied.
      The discount value checks move to step 4 when the vendored shape is next
      re-vendored from `@tallyui/core/server`;
   2. **the replay read**: a plain `SELECT` of the ledger by command id,
      before any claim. A recorded id answers as recorded (`duplicate` with
      the stored result, the stored rejection, `idempotency_mismatch` for
      another payload or channel, 409 for `needs_admin`) without entering the
      claim, so a committed sale whose response was lost always replays,
      whatever its values would now fail;
   3. **the collision lookup** on `clientOrderId`; a sale already recorded
      goes to the collision guard after the claim;
   4. **the value refusals**, `invalid_payload`, not stored: every field
      against the command's own version (ruling 17, §5), the amounts, the
      pure quantity checks (at or below 0, fractional, above int4), the v3
      fiscal figures, the length bounds (`customer.email` 254; refs, ids
      and names 255; `sessionId` 36), and the `createdAt` bound, which is
      future-only (at most 24 h after the server clock, no lower bound: an
      offline till sends old sales). `invalid_payload` keeps one meaning
      across the contract, as in `@tallyui/core/server`'s `precheckCommand`.
      The length bounds and the strict check sit here, not in step 1 (Front
      desk, TallyUI #222 review; #36 review), so a stored answer always
      wins: an applied command resent with a value now over a bound, or with
      a field the strict check now refuses, replays as `duplicate`, and a new
      id for its `clientOrderId` gets the collision guard's answer;
   5. **the claim**, in the command's own `withTransaction`: `INSERT … ON
      CONFLICT`, whose conflict handling stays the safety net for a
      concurrent request; then the collision guard answers a recorded sale;
   6. **the stored and unstored checks**, before the recipe writes
      anything, so no event fires (TallyUI #219, Front desk):
      - stored on the claim, the state-dependent per-sale facts:
        `unknown_variant` (missing, deleted or disabled variant, disabled or
        deleted product, another channel's variant) and `underpaid`; the
        till's Retry mints a new id and is checked again. `invalid_quantity`
        is reserved for quantity refusals that depend on the catalogue; the
        plugin has none today;
      - not stored, with the whole transaction rolled back and the claim
        released, so the same command id applies once the store is fixed:
        `unsupported_currency` and `store_configuration` (tax zone, the POS
        methods and their plugin checkers and handler, the manual
        fulfilment handler, and the order limits `orderItemsLimit` and
        `orderLineItemsLimit`, checked here before the first write; a limit
        Vendure itself refuses after the draft exists is a race and rolls
        back as transient, R1). `unsupported_tax_mode` is store-wide too:
        the plugin does not emit it today, but found after the first write
        it would compensate, then answer unstored with the claim released;
   7. **the recipe**.
3. It stops at the first 409 or 503, as medusapos's `process.ts` does.
   Earlier commands have already committed, so on the retry they replay as
   `duplicate` (ADR-039).

**Vendure constraint: response bodies.** Vendure's global
`ExceptionLoggerFilter` rewrites every thrown `HttpException` into
`{ statusCode, message, timestamp, path }`, which drops `code` and `id`
(found in spike S1). So the 409 `{ code: 'in_progress', id }` and 503
`{ code: 'transient', id, message }` bodies are written through the
Express response (`@Res({ passthrough: true })`), never thrown.

**The claim.** A `TallyCommand` entity (command id as primary key,
`channelId`, `clientOrderId`, fingerprint, status, result JSON) is claimed
inside the command's transaction:

- `SET LOCAL lock_timeout = '5s'`, then `INSERT … ON CONFLICT DO NOTHING`.
  A second request for the same id waits on the uncommitted row. After 5 s
  it answers 409 `in_progress`, which the outbox retries. Right after the
  claim the timeout becomes `10s` for the rest of the recipe (VP3, Front
  desk ruling 7): no wait anywhere is unbounded, and a lock timeout after
  the claim answers 503 `transient` (kind `timeout`), which the till retries. The order save
  keeps the claim's 5 s and its 409. The sale's `stock_level` rows are
  locked with a 5 s timeout (ruling 6; see "Concurrent sales" below).
- Once the first request commits, a replay reads the stored result
  (`duplicate`, same `serverRefs`). A different fingerprint gives
  `idempotency_mismatch`. A command id already claimed in another channel
  gives `idempotency_mismatch` with `reason: 'command_in_other_channel'`,
  never that channel's answer.
- A different command id for a `clientOrderId` that already has an order
  (a requeue, which mints a new id) meets the collision guard below.
  `Order.tallyClientOrderId` is unique, as the last guard.
- If the transaction fails, the ledger row rolls back with the order, so a
  retry starts clean. If the client times out while the server commits, it
  retries with the same id and gets `duplicate`. That is the outbox's
  normal path, and needs no resume logic.

**Error results become throws.** Every Vendure service method that returns
an `ErrorResult` (a state transition refused, stock, a payment declined) is
turned into a throw, so the sale's writes roll back. A half-built order
never commits.

**Error classes** (Front desk ruling 1 and re-rulings 1–5, VP2a; TallyUI
ADR-038's `platform_error` amendment). The table is
`src/service/classification.ts`, with a test per row.

- **Stored rejections are decided before the recipe's first event.** The
  deterministic checks above run after the claim and before any write. **A
  Vendure fact** (accepted by the Front desk, TallyUI #219): the recipe
  publishes its first event at its first write, `CustomerService.createOrUpdate` for a new
  buyer (a `CustomerEvent`), otherwise `OrderService.createDraft` (an
  `OrderEvent` and the transition to `Draft`), both before the transition
  to `ArrangingPayment`. Vendure's EventBus delivers an event when the outer
  transaction commits, even if it came from a rolled-back savepoint, so no
  error from the recipe is ever turned into a stored rejection:
  - **a race** (a variant disabled, stock taken, a limit or the
    configuration changed during the sale: `unknown_variant`,
    `insufficient_stock`, a permanent-list `ErrorResult`, which TallyUI #219
    R1 keeps transient after the first write), and any other
    `ErrorResult` or database, driver, network or unknown-SQLSTATE error,
    is **transient**: the whole transaction rolls back, its events are
    dropped, the claim is released, and the resend's checks answer it. Only
    the claim's own lock timeout, and the unique `tallyClientOrderId` wait
    below, answer 409;
  - a declined or otherwise not `Settled` `tally-pos` payment, or a refused
    `PaymentSettled` with enough payment and a configuration cause, answers
    `store_configuration` after a full rollback, not stored;
  - a `clientOrderId` collision met in the recipe rolls back and runs the
    command again, so the collision guard answers it before any write;
  - a `PluginBugError` (an invariant of the plugin's own code, raised
    explicitly; nothing parses stacks) **before** the recipe's first write
    is a stored `internal_error`, with a generic message and a correlation
    id, the raw error only logged (TallyUI #219 R2); **after** the first
    write it keeps the partial sale for an admin (`needs_admin`). A native
    error, the plugin's own `TypeError` included, is transient.
    `internal_error` stays in the contract for other plugins too.
- **`platform_error`** comes only from an admin's rejection of a
  `needs_admin` row, with `platformCode: 'TALLY_ADMIN_REJECTED'` and the
  admin's reason as `platformMessage`. `TALLY_` is the reserved prefix of
  the platform codes the plugin makes up itself. The permanent list
  (`PERMANENT_ERROR_RESULTS`) documents the conditions the checks cover.
- **The collision guard.** A `clientOrderId` already recorded in this
  channel answers `applied` only when the order's own command row is
  `applied`: the new command id is then stored as `applied` with that
  result's refs and warnings, and replays as `duplicate`. A row that is
  `needs_admin` answers 409, and so does a sale still in progress, whose
  unique key the new command waits on for the claim's 5 s. A new command id
  never gets round a 409 or an admin mark. In another channel, the
  collision is a stored `idempotency_mismatch`, including from the default
  channel, where Vendure also places every channel's orders: the order's own
  command row decides whose sale it is.
- **`needs_admin`.** The sale is committed as far as it got and kept for
  an admin when the stock take-back after fulfilment (in a savepoint of its
  own) fails, or when a `PluginBugError` stops the recipe after its first
  write. The plugin never answers `platform_error` for it and never
  releases the claim: the row is marked `needs_admin` with the sale's refs
  and the exact location and quantity of every stock top-up,
  `Logger.error` names the command id, and every resend, and every new id
  for the same `clientOrderId`, answers 409 `in_progress`. An admin resolves
  it with `OrderCreateService.resolveNeedsAdmin`:
  - either resolution first takes back the leftover top-up, at the recorded
    location (the admin's channel may have another default location);
  - `applied` then replays the stored refs as `duplicate`;
  - `rejected` cancels the settled `tally-pos` payments, cancels the order
    with Vendure's `cancelOrder` (or leaves an order the admin already
    cancelled), then **releases** the client id: `tallyClientOrderId` is
    cleared and the id moves to the non-unique `tallyRejectedClientOrderId`,
    and the order is flagged `tallyRejected`. All of it commits with a
    compare-and-set of the row to `rejected`, or none of it does: a failed
    step refuses the rejection, and a crash leaves the row `needs_admin` for
    a repeat. A rejected row never keeps a live order and there is never a
    second live order for one client id, so the till's Retry under a new id
    is a new sale.
  - **Register figures.** An order flagged `tallyRejected` counts as never
    placed: any register figure the plugin computes (expected cash,
    session totals, ADR-068) must exclude it, and only the Retry's new sale
    counts. The plugin computes no register figure yet; the register work
    inherits this rule.

**What this retires, measured.** medusapos's lease, fencing token, advisory
lock and resume are 310 physical lines on its `main` (5c23a74):
`tally-ledger/service.ts` 150, `execute.ts` 104, `resume.ts` 56. They exist
because a Medusa workflow spans modules and cannot be one database
transaction (its ADR 0020). The Vendure ledger keeps the claim and result
parts of `service.ts`, and drops the lease, the fencing token, the advisory
lock and `resume.ts`.

### 3. A POS sale is a Vendure Order

| POS concept | Vendure mechanism (adopted) | Replaces (not carried over) |
|---|---|---|
| The sale | A draft `Order` in the request's channel, moved through Vendure's own order process: `Draft → ArrangingPayment → PaymentSettled`, then fulfilled. `orderPlacedAt` is set on the last transition; the plugin overwrites it with `tallySaleAt` (the payload's sale time) in the same transaction, so Vendure's reports match the till | Status workarounds such as WCPOS's `pos-open`/`pos-partial`; a sale that reaches the server is always paid |
| Currency | `ctx.currencyCode` is set from `payload.currency` before any line is added. A currency the channel does not offer is `unsupported_currency`, answered after the claim and before any write with the claim rolled back and nothing stored (TallyUI #219), so the same command id applies once the channel is fixed. S1 did not prove this; VP1 implements and tests it | Repricing lines in the channel's default currency |
| Lines | One `OrderLine` per POS line. Vendure merges equal lines, so a read-only line custom field `tallyClientLineId` keeps them 1:1 | — |
| Stock | After the stock lock, probe `StockLocationStrategy` with a copied context: top up at the first planned location if the plan covers q, otherwise at `defaultStockLocation`. Top up by `max(0, q − saleable)` before `addItemToOrder` and `ArrangingPayment`, then check saleable ≥ q. The POS-only `TallyStockLocationStrategy` caps allocations cumulatively at q and adds any remainder at the default location; storefront plans are unchanged. After `PaymentSettled`, check Σ allocations per POS line = its quantity. Either failed check is an unstored `store_configuration`. Manual fulfilment draws where allocated; take back each top-up at its own location in the transaction. `payload.locationId` is an instruction field and is refused (invalid_payload) until it is honoured: vendurepos/app#35 (ruling 19, §5). Warn only for positive `max(0, q − max(0, onHand − allocated))`: it is the units of this sale not covered by physical stock, never more than q and never counting the out-of-stock threshold; a pre-existing negative on-hand is store state, not this sale's shortfall, and the till learns it through stock sync, not the warning (Front desk, 2026-09-29). | Stock-reduction hooks and reservation tables |
| As-sold price and tax mode | An `OrderItemPriceCalculationStrategy` that wraps the configured one. Only on orders with `tallyClientOrderId`, it returns the read-only line custom field `tallyUnitPrice`, with `priceIncludesTax` set to the line's own mode (`lines[].taxInclusive`, falling back to the order's `pricesIncludeTax`), which it reads from a second read-only line field, `tallyPriceIncludesTax`, because the strategy sees only the order and the line's custom fields. Vendure's `PriceCalculationResult` carries both, so per-line tax mode needs no other workaround (proved in S1) | Rewriting line totals through post meta |
| Discounts (v2/v3) | One negative, **taxable** `Surcharge` per discounted line (`POS discount`, SKU `TALLY-DISCOUNT`) of `-discountMinor`, in that line's tax mode. Its tax lines copy the line's rate and description, so the order-level tax group for that rate shrinks by the discount. A net unit price was rejected: `(unit × qty − discount) / qty` is not an integer in general | Coupon emulation |
| Server promotions | **None on POS orders.** The POS has already applied its own discounts. Four calls re-apply the channel's active promotions while the order is built: `addItemsToOrder`, `addSurchargeToOrder`, `setShippingMethod`, and the coupon revalidation inside `addPaymentToOrder`. So the recipe ends with one final pricing pass, `orderCalculator.applyPriceAdjustments(ctx, order, [])`, followed by explicit saves of the order, its lines and its shipping lines. `order.promotions` and every line's promotion adjustments are saved empty. A later edit in the Dashboard would re-apply the channel's promotions; POS orders are not meant to be edited there | Settling promotion differences in a surcharge |
| Tax and money authority | The configured `TaxZoneStrategy` and the merchant's tax strategy, unchanged. **The till's totals are the fiscal record** (as in medusapos ADR 0012). One untaxed `TALLY-ROUNDING` surcharge bridges **any** difference between Vendure's total and `totalMinor` (ADR-048). The order is always recorded, and is never refused as `total_mismatch`. The size of the bridge comes back as a `totalWarnings` entry. The surcharge is added through the repository followed by `calculateOrderTotals`, so it causes no promotion pass. The plugin rounds no money itself: the bridge is an integer difference, and the tolerance is a ceiling. Any division the plugin does add rounds half away from zero. Vendure's own tax rounding is accepted as it is: it uses `Math.round`, so −59.5 on a negative surcharge becomes −59. The bridge and the tolerance absorb the difference (Front desk ruling, after S1). ADR-048's bound widens to ⌈(lines + surcharges) / 2⌉ minor units, and S1 asserts that the bridge never exceeds it in any parity case. Per-rate figures are compared with that tolerance against the v3 `taxByRate`, and any difference is reported as a warning, never refused | WooCommerce's single "prices include tax" option, and changing store settings to match the POS |
| Payment | One shared `tally-pos` `PaymentMethod`, assigned to every channel. Its handler returns `Settled` payments created with `PaymentService.createPayment`, one per tender (`cash` or `external`) as given. A sum of tenders above the total is allowed (ADR-039): the covering tender's Vendure payment is capped, so Vendure accepts the payments as covering the order exactly. The **full tender list, including change, is stored on the order** in a read-only `tallyPayments` field, as medusapos's `tally_payments` is. That list is the fiscal record, and a register's expected cash derives from it, never from Vendure's payment rows. A zero-total sale has no payment, so the plugin makes the `PaymentSettled` transition itself | Payment-gateway emulation |
| Collection | One shared in-store `tally-in-store` `ShippingMethod` with a zero calculator, assigned to every channel | Hiding shipping lines |
| Closed to the storefront | The `tally-pos` payment method and the in-store shipping method each have an eligibility checker that accepts only orders carrying `tallyClientOrderId` created through the plugin's authenticated route. The payment handler also refuses unless `ctx.apiType === 'custom'`. A Shop API customer can never settle an order with `tally-pos` or pick the in-store method | — |
| Customer | In order: the customer from `customer.customerId` (v3) when it exists in this channel; else the customer found by email in any channel (and added to this one; never renamed), or created with `CustomerService.createOrUpdate` only when none exists (ADR-047); else the walk-in placeholder customer. An unknown or foreign `customerId` falls back with a `customer_ignored` warning; it never rejects the sale. An over-long one (above 64) is malformed and refused as `invalid_payload` (Front desk, 2026-09-30, vendurepos/app#43). A lookup miss is checked again under a per-email advisory lock held to commit, so concurrent first sales for one new email create one customer; an existing customer, the walk-in included, never takes that lock. "One customer per email" holds across POS sales only, because Vendure's own customer-creation paths (Shop API registration, Admin API, guest checkout) do not take the plugin's lock. The email lookup ignores the stored case, so a mixed-case row stored before Vendure normalised emails, or imported, is found; of several such rows the lowest id wins (VP3-4c). Adding the customer to this channel is an `INSERT … ON CONFLICT DO NOTHING` on the join table, so a concurrent sale adding the same customer waits for that commit and applies instead of failing on the duplicate key (VP3-4b). A new-id resend of a first sale for a new email that is still in progress therefore waits on that email lock and answers 503 `transient` (kind `timeout`), not 409 `in_progress`, and after the first commits its retry returns the recorded result (Front desk ruling 15, 2026-09-30). The per-email lock cannot tell the same sale from another sale by the same new buyer, so it answers the generic transient; the till retries a 409 and a 503 the same way | Guest-order meta |
| No customer email | POS orders send no order-confirmation email, matching Medusa's `no_notification`. The plugin exports a wrapped `orderConfirmationHandler` that skips orders with `tallyClientOrderId`, and the quick-start tells merchants to install it in their `EmailPlugin` handlers. In 3.7.3 the order confirmation fires on `OrderStateTransitionEvent` to `PaymentSettled`. S1 proved the filter with a testing transport; the first plugin e2e proves it with a real transport | — |
| Till, drawer and cashier | Order custom fields: `tallyRegisterId` is the till's **device** id (medusapos ADR 0017/0019); `tallySessionId` (v3) identifies the drawer session (ADR-068); `tallyCashierRef`; `tallySaleAt`. Register sessions, movements and closures are their own commands and entities later (ADR-068); the order only references them. TallyUI records the device meaning in ADR-038/068 | `_wcpos_register`, `_wcpos_session` and `_pos_user` post meta; the WooCommerce sale counter, which TallyUI's payload does not carry and this plugin does not add |
| Receipt snapshot (v3) | `display` and `taxByRate` are stored unchanged in a read-only `Order.tallySnapshot` text field, so the order carries the receipt exactly as the cashier printed it | Rebuilding a receipt from server totals |
| Order number | Vendure's own order `code`, returned as `serverRefs.displayId` | — |

**Custom fields.** All are read-only in the Admin API. Vendure enforces that
only at the API layer, so the plugin writes them directly. `unique` gives
`tallyClientOrderId` its index. The plugin's migration adds plain indexes on
`tallyRegisterId` and `tallySessionId`, because custom fields have no index
option. The second migration (`TallyPosVp2a1790720000000`) adds the
non-unique `tallyRejectedClientOrderId` and the `tallyRejected` flag of an
admin-rejected order, and the ledger's `topUps`.

**Store configuration.** There is one shared `tally-pos` payment method and
one shared `tally-in-store` shipping method, assigned to the default channel
and every channel that uses them, and one walk-in customer, assigned to every channel.
Bootstrap creates or assigns them in each channel without a superadmin.
When a sale's pre-check finds a deleted or unassigned POS method and the other
setup checks pass, it rolls back the claim and repairs the channel's setup in
its own short transaction. Bootstrap and repair take the same two-int
transaction-scoped advisory lock, with a 5-second lock timeout, and re-read
live rows before creating or assigning them. Soft-deleted shipping rows stay
deleted; repair creates a new row. The repair commits even if the sale is
later refused, and the command runs once more, with no repair loop.
The walk-in is never a repair trigger: the pre-check does not look at it, and the
sale's customer step finds it and adds it to the channel, or creates it, inside the sale.
A disabled payment method remains disabled and answers `store_configuration`.
A payment method that is disabled (or has a replaced handler) and is also
unassigned from the channel is re-assigned by the repair, then refused on the rerun.
Replaced handlers or checkers, missing manual fulfilment or usable default-zone
tax rates, and setup still missing after the single repair also answer
`store_configuration`, with the claim rolled back and nothing stored
(TallyUI #219). Repair errors are transient; a repair lock timeout is a 503,
never a 409 (Front desk rulings 9–13, 2026-09-29).
The repair runs in the till's own request context and grants its role
nothing. It works because the Vendure 3.7.3 service methods it calls
(`ShippingMethodService.create`, `PaymentMethodService.create` and `update`,
`ChannelService.assignToChannels`, `CustomerService.createOrUpdate`) check no
permissions, so a `CreateOrder`-only till can repair. The least-privilege test
in `route.e2e.ts` is what fails if a Vendure upgrade adds such a check.

**The customer lookup and its index (Front desk ruling 16, 2026-09-30).** The
lookup stays `LOWER(customer.emailAddress) = LOWER(:emailAddress)` among rows
with `deletedAt IS NULL`. Vendure has no index for that expression, so **every
lookup that has an email is a sequential scan of `customer`**: on 100,000
customers, 1,334 shared buffers and about 15 ms, against an index scan of 4
buffers and 0.02 ms with the index below (VP3-4d `EXPLAIN (ANALYZE, BUFFERS)`).
The per-email advisory lock hashes `lower(email)`, as the lookup matches,
because Vendure's `normalizeEmailAddress` lowercases only input that looks like
an email (`Jane@Localhost` keeps its case) (VP3-4d).
**The plugin leaves Vendure's `customer` table alone**: no migration, no
TypeORM metadata and no index created at start. An index on a table the plugin
does not own is schema drift in every merchant's `migration:generate`. VP3-4d
probed it on Vendure 3.7.3 with TypeORM 0.3.31: a plain index TypeORM does not
know comes out as `DROP INDEX "public"."IDX_probe_plain_email"`; the expression
index below comes out as nothing ("No changes in database schema were found -
cannot generate a migration."), because TypeORM's Postgres schema reader finds
index columns with an inner join on `pg_attribute`, which an expression has no
row in, so it never loads the index. The ruling stands on the rest: that silence is a TypeORM
detail a later version may change, and an index the plugin created would
surprise a merchant at uninstall (left behind on Vendure's table) and at a
Vendure upgrade that alters `customer`. The index is therefore the merchant's
choice: the plugin README's section "Optional: an index for POS customer
lookups" gives `CREATE INDEX CONCURRENTLY "IDX_customer_email_lower" ON
"customer" (lower("emailAddress")) WHERE "deletedAt" IS NULL;`, whose expression
and predicate the lookup matches. On start the server process logs one warning
when `customer` has more than 50,000 rows (the planner's estimate) and no
`lower("emailAddress")` index. After the first walk-in sale in each process, a
walk-in sale skips the email lookup: its
customer's id is cached per process, and the id cache is checked by primary key
on every use, so an admin's delete or change falls back to the lookup.

### 4. TallyUI's contract, and the WCPOS engine it moves to

The command envelope, the fingerprint rule, the result and error
vocabulary, capability discovery and the exact integer tax maths (ADR-037)
are TallyUI's, and the plugin only serves them. The local `PosOrder`, with
its frozen fiscal snapshots, and register sessions (ADR-032, ADR-068) stay
on the client.

The command outbox itself is temporary (ADR-067 decision 7). The
`TallyCommand` ledger is the idempotency store that a later Vendure driver
for the WCPOS engine reuses: the engine's `Idempotency-Key` is the command
id. Against the engine's mechanisms, as medusapos ADR 0020 does for Medusa:

| WCPOS engine mechanism | Vendure driver | Vendure primitive and reason |
|---|---|---|
| Mutation queue: durable, `Idempotency-Key`, drain lease, dead letters | **Keep** | Client-side and engine-owned. The server half is the `TallyCommand` ledger (§2), keyed by the command id |
| Conflict states and dead-letter recovery | **Keep; the driver maps codes** | The plugin answers business refusals per command in a 200 (§2). `unsupported_version` keeps its own state, so the version fallback survives the move |
| Money authority: the server's totals win | **Replace (inverted)** | The till's totals and `tallyPayments` are the fiscal record; Vendure's totals are a reconciliation view, with the bridge reported in `totalWarnings` (§3) |
| Full-document REST writes | **Replace with commands** | The till states intent (`order.create`, later `register.*`), and the plugin runs Vendure's services |
| Cross-resource transactions: none in WordPress | **Replace with one real transaction** | Vendure services share one `TransactionalConnection` transaction per command, so the claim, order, payments, stock and ledger commit together (§2). No lease, lock or resume |
| Revisions (`If-Match`) | **Replace later with typed revisions** | Orders are created, never edited, by the till, so the order path needs no revision; a later driver can use the ledger's result and the order's `updatedAt` |
| Web multi-tab write leader | **Drop** | Single-instance storage: one tab, one database (Paul, 2026-09-24) |
| Sale counter and `_wcpos_*` meta | **Drop** | Typed, indexed custom fields replace the meta (§3); TallyUI's payload carries no sale counter |

### 5. Versions

The plugin advertises `{"contracts":{"order.create":[1,2,3]}}` from its
first release, because v3 is what TallyUI `main` sends:

- each version is validated strictly against its own shape, and v3 is
  pinned by ADR-065's `order-create-v3.json` fixture. Strictly means
  (Front desk ruling 17, 2026-09-30): a field the command's version does
  not know, at any level (envelope, payload, `lines[]`, `payments[]`,
  `customer`, v3's `display` and `taxByRate`), is an unstored
  `invalid_payload` in step 4, after the replay read (a stored answer
  always wins), naming its full path, e.g.
  `lines[2].discountMinr`; a field of a later version (v1
  `discountMinor`, v1 or v2 `sessionId`, `display`, `taxByRate`,
  `customer.customerId`) names the version it requires. The contract
  declares no free-form map inside `order.create`, so no object takes
  arbitrary keys, and every new field needs a version bump. The reason: a
  money field accepted and ignored makes the till believe a discount was
  given while the server charges the full price. No released till is
  refused: `@tallyui/pos` 2.0.0 sends v1 only without a discount and v2
  with one, and its exact envelopes are the regression fixtures
  (`test/strict-shape.e2e.ts`, `src/service/strict-shape.ts`);
- a declared field is either an **instruction** or **informational**
  (Front desk ruling 19, 2026-09-30, made precise the same day). An
  instruction asks the server to do something different (where stock
  comes from, which customer, which price): it is honoured or refused.
  Informational fields are the till's own record (`title`, `subtotalMinor`,
  `taxMinor`, `deviceId`, `attempt`). A server may leave them unused, and
  never refuses a command because they differ from its own computation. A
  command whose own figures contradict each other, or carries a malformed
  value, is malformed and is refused as `invalid_payload` (version 3:
  `taxMinor` against `display.taxMinor` and the `taxByRate` sum); that is a
  check of the command, not of the server's view of it. `payload.locationId`, which the contract declares without a
  version, is an instruction this server does not honour yet, so it is
  refused in every version with `invalid_payload` "payload.locationId:
  not supported by this server yet" until vendurepos/app#35 honours it
  (see "Stock"). Each field's kind and what the server does with it today
  are listed under "Field kinds" below;
- for **v1 and v2** the server sends **no subtotal or tax warning**.
  `subtotalMinor` and `taxMinor` are not compared with Vendure's figures,
  and only `totalMinor` is (`total_mismatch` and the rounding bridge).
  - **v3 adds one per-rate check:** each rate's `taxByRate` total is
    compared with Vendure's `taxSummary` for that rate, within the tolerance
    ⌈(lines + surcharges) / 2⌉. A difference beyond the tolerance comes back
    as a `tax_rate_mismatch` warning (svc:680-699).
  - **That tolerance absorbs the rounding measured in #38:** no measured
    difference exceeds it. `subtotalMinor` is not compared in any version.
  - **Why the warnings stop there** is measured. The till rounds tax once
    per order, while Vendure rounds per line (default strategy) or per rate
    group (order-level). On the demo catalogue an exact compare differs by
    1–3 minor units on 13–60 % of multi-line sales (vendurepos/app#38).
  - **What comes next** (Front desk ruling, 2026-09-30): the fix is the
    rounding rule, not a tolerant warning.
    - The till computes its figures with the tax rounding strategy the
      store advertises in `/info` (TallyUI/tallyui#287, after order.create
      v4).
    - This plugin advertises Vendure's configured strategy as `taxRounding`
      (see "`taxRounding`" below).
    - `figures_mismatch` (TallyUI #281's shape) may ship once tills that
      follow the strategy are released. It is its own PR, comparing
      exactly: `subtotalMinor` and `taxMinor`, and `discountMinor` from v4
      on.
    - A store advertising `{"granularity":"custom"}` never gets a subtotal
      or tax `figures_mismatch` from this server.
- a higher version gets `unsupported_version` with `data.orderCreate: 3`
  before the claim;
- v1 and v2 orders simply have no snapshot or session id.

`/info` and the version gate read the plugin's own `ORDER_CREATE_VERSIONS`
(`service/constants.ts`), not the vendored `SUPPORTED_ORDER_CREATE_VERSIONS`,
so a new version is advertised only by the plugin PR that implements it
(Front desk, 2026-09-30). `test/versions.e2e.ts` pins this.

**`taxRounding`.** Beside `contracts`, `/info` has a top-level
`taxRounding`, whose value is core's TaxRounding JSON
(TallyUI/tallyui#287). The till computes its figures with it, so they
match Vendure's (Front desk ruling on vendurepos/app#38, 2026-09-30).
`service/tax-rounding.ts` maps the configured strategies once at
bootstrap. They are store-wide, so every channel gets the same value.

| Vendure configuration | `taxRounding` |
|---|---|
| `DefaultOrderTaxCalculationStrategy` (the default) | `{"granularity":"per_line_items","mode":"half_up"}` |
| `OrderLevelTaxCalculationStrategy` (the dev store) | `{"granularity":"per_rate_group_items","mode":"half_up"}` |
| Any other order tax strategy (a subclass included), a money strategy other than `DefaultMoneyStrategy`, or a tax line strategy other than `DefaultTaxLineCalculationStrategy` | `{"granularity":"custom"}` |

- **Exact classes, never `instanceof`.** A subclass may round
  differently. The field is never omitted: absence means an older server,
  and the till would then assume `per_order`.
- **The items** are each undiscounted line and its −D `TALLY-DISCOUNT`
  surcharge (svc:654-667). A surcharge joins its line's rate group, which
  is keyed by the rate's name and value.
- **Measured** (vendurepos/app#38 and the discount scoring): 0 of 1,420
  undiscounted baskets differ, and 0 of 1,000 discounted baskets in each
  strategy and price-mode cell.
- **`half_up`:** `DefaultMoneyStrategy` is `Math.round`. It differs from
  half away from zero only on exact negative halves: −59.5 on a discount
  surcharge becomes −59 (see "Tax and money authority").
- **One rate per line.** `DefaultTaxLineCalculationStrategy` gives each
  line one rate. Another tax line strategy may stack rates, and the till
  splits a stacked line's tax differently from Vendure (TallyUI #312), so
  such a store is `custom`.
  - **Settled in TallyUI #312** (https://github.com/TallyUI/tallyui/issues/312#issuecomment-5907259252): with stacked rates, the till's order figures follow Vendure exactly. Only the per-rate rows differ, by up to a unit: Vendure rounds each rate's share on its own, while the till gives the last rate the remainder.
  - **This store stays `custom` anyway,** because a custom tax line strategy can do more than stack (Front desk, 2026-09-30).
- **Known gap: inclusive lines under `per_rate_group_items`.** The till
  uses `per_order` figures for them until TallyUI #310. Until then, those
  baskets are still bridged with a `total_mismatch` warning, never
  refused.

#### Field kinds (ruling 19)

Every declared `order.create` field, its kind, and what the server does
with it today. Locations are in `packages/vendure-plugin/src/`:
`service/order-create.service.ts` (written `svc`), `service/strict-shape.ts`,
`service/value-ranges.ts`, `config/strategies.ts`, and the vendored
`vendored/payload-shape.ts` and `vendored/fiscal-figures.ts`. "Stored"
means kept on the Vendure order or its payments. Besides what is listed,
every field is checked against its version in step 4 (ruling 17).

| Field | Kind | What the server does today | Where |
|---|---|---|---|
| **Envelope** | | | |
| `id` | instruction (identity) | the idempotency key: the replay read and the ledger claim | svc:139, svc:501 |
| `type` | instruction | only `order.create` is accepted | svc:318 |
| `version` | instruction | selects the shape: the strict check, v3's fiscal figures, session id and snapshot | svc:323, svc:343, svc:347, svc:593, svc:742 |
| `createdAt` | informational | type-checked and future-bounded only; not stored | svc:320, svc:346 |
| `deviceId` | informational | type-checked only; not stored | svc:321 |
| `attempt` | informational | type-checked only; not stored | svc:322 |
| `payload` | the order | the fields below | |
| **Payload** | | | |
| `clientOrderId` | instruction (identity) | the collision lookup and guard; stored as `tallyClientOrderId` | svc:142, svc:590 |
| `createdAt` | instruction | the sale's time: stored as `tallySaleAt` and `orderPlacedAt` | svc:591, svc:741 |
| `currency` | instruction | the order's currency; `unsupported_currency` when the channel does not offer it | svc:150, svc:380 |
| `pricesIncludeTax` | instruction | each line's tax mode, unless the line gives its own | svc:645, svc:659 |
| `lines` | instruction | one Vendure order line each | svc:640-646 |
| `subtotalMinor` | informational | type- and range-checked only; not compared, not stored (vendurepos/app#38) | payload-shape.ts:52, value-ranges.ts:39 |
| `discountMinor` (v2+) | instruction | must equal Σ `lines[].discountMinor`, which is what is applied; range-checked | payload-shape.ts:56, value-ranges.ts:39 |
| `taxMinor` | informational | v1/v2: type- and range-checked only (vendurepos/app#38); v3: must equal `display.taxMinor` and Σ `taxByRate[].taxMinor`; not stored | payload-shape.ts:52, value-ranges.ts:39, fiscal-figures.ts:93, fiscal-figures.ts:95 |
| `totalMinor` | instruction | the order's total: Vendure's total is bridged to it with a `total_mismatch` warning; `underpaid` below it; caps the payments | svc:396, svc:670-678, svc:707 |
| `payments` | instruction | one Vendure payment per tender until the total is covered; stored as `tallyPayments` | svc:708-711, svc:740 |
| `customer` | instruction | the order's customer (fields below); absent or `null` is the walk-in customer | svc:555-556 |
| `registerId` | informational | stored as `tallyRegisterId` | svc:592 |
| `cashierRef` | informational | stored as `tallyCashierRef` | svc:594 |
| `locationId` | instruction | refused with `invalid_payload` until vendurepos/app#35 | strict-shape.ts:49 |
| `display` (v3) | informational | cross-checked (fields below) and stored in `tallySnapshot` | svc:743 |
| `taxByRate` (v3) | informational | cross-checked, compared per rate (fields below) and stored in `tallySnapshot` | svc:743 |
| `sessionId` (v3) | instruction (honoured by recording) | recorded verbatim on the order as `tallySessionId`, which ties the sale to its register session for register close, like `payments[].method` (Front desk, 2026-09-30) | svc:593; tested at recipe.e2e.ts:97 |
| **`lines[]`** | | | |
| `clientLineId` | informational (reference) | stored as the order line's `tallyClientLineId`; matches the line's discount and display line | svc:644, svc:656 |
| `variantId` | instruction | the variant sold; `unknown_variant` when missing or disabled | svc:398, svc:609 |
| `title` | informational | type-checked only; not stored (the Vendure line takes the variant's name) | payload-shape.ts:37-38 |
| `quantity` | instruction | the line's quantity | svc:642 |
| `unitPriceMinor` | instruction | the line's unit price, through the POS price strategy | svc:643, strategies.ts:29 |
| `taxInclusive` | instruction | the line's tax mode | svc:645 |
| `discountMinor` (v2+) | instruction | a negative `POS discount` surcharge carrying the line's tax lines | svc:655-660 |
| **`payments[]`** | | | |
| `clientPaymentId` | informational (reference) | stored in the payment's metadata and in `tallyPayments` | svc:711, svc:740 |
| `method` | instruction (honoured by recording) | recorded, never refused: each Vendure payment keeps its tender, `method` included, in its metadata, and the order keeps every tender in `tallyPayments` (a surplus tender after the covering one only there, tested at recipe.e2e.ts:179); every payment runs through the one POS payment method, so the till's method is what tells cash from external at register close (Front desk, 2026-09-30) | svc:711, strategies.ts:95, svc:740; tested at recipe.e2e.ts:161-162 |
| `amountMinor` | instruction | the payment's amount, capped at what the total still needs; `underpaid` when the sum is below the total | svc:396, svc:710-711 |
| `tenderedMinor`, `changeMinor`, `reference` | informational | range-checked; stored as above | value-ranges.ts:61-62, svc:711, svc:740 |
| **`customer`** | | | |
| `email` | instruction | the customer, matched case-insensitively or created | svc:555-556 |
| `customerId` (v3) | instruction | the customer by id. A well-formed id the store cannot resolve (unknown, in another channel, deleted) never holds the sale: the sale is kept with the email or walk-in customer and a `customer_ignored` warning naming the id. An id over 64 characters is malformed and refused as unstored `invalid_payload`, "customer.customerId: expected a string of at most 64 characters" (TallyUI core's message), after the replay read, so an applied command still replays (Front desk, 2026-09-30, vendurepos/app#43). A refusal is for a problem that would make every sale from this till fail until the store is fixed (a stock location, a sales channel), so it is noticed at once and the retry applies; a problem with one sale's own references is not, because a sale stuck in an outbox for days is worse (Front desk, 2026-09-30) | value-ranges.ts:42-48, payload-shape.ts:65, svc:544-550; tested at ledger.e2e.ts:246 (unknown; another channel: the walk-in, not added to it), ledger.e2e.ts:271 (64 applies, over 64 refused), ledger.e2e.ts:642 (over 64 replays) |
| **`display` (v3)** | | | |
| `currency` | informational | must equal `payload.currency` | fiscal-figures.ts:91 |
| `exponent` | informational | must equal the currency's decimals | fiscal-figures.ts:105 |
| `taxInclusive` | informational | type-checked only | fiscal-figures.ts:64 |
| `subtotalMinor`, `discountMinor`, `orderDiscountMinor` | informational | type-checked only | fiscal-figures.ts:65 |
| `taxMinor` | informational | must equal `payload.taxMinor` | fiscal-figures.ts:93 |
| `totalMinor` | informational | must equal `payload.totalMinor` | fiscal-figures.ts:92 |
| `lines[].clientLineId` | informational | must name a `payload.lines[]` line, once | fiscal-figures.ts:100-101 |
| `lines[].amountMinor` | informational | type-checked only | fiscal-figures.ts:71 |
| `lines[].discounts[].discountId`, `.label`, `.amountMinor` | informational | type-checked only | fiscal-figures.ts:76-78 |
| **`taxByRate[]` (v3)** | | | |
| `ratePpm` | informational | keys the comparison with Vendure's tax summary | fiscal-figures.ts:86, svc:686 |
| `code` | informational | type-checked only | fiscal-figures.ts:87 |
| `netMinor` | informational | `grossMinor` must equal `netMinor + taxMinor` | fiscal-figures.ts:96 |
| `taxMinor` | informational | Σ must equal `payload.taxMinor`; each rate is compared with Vendure's tax for that rate, a difference beyond the rounding tolerance giving a `tax_rate_mismatch` warning | fiscal-figures.ts:95, svc:685-696 |
| `grossMinor` | informational | must equal `netMinor + taxMinor` | fiscal-figures.ts:96 |

**When the till's amounts differ from the server's.** In every version
`totalMinor` is compared with the server's own computation: Vendure's
total is bridged to it by a `POS rounding` surcharge, and the result
carries a `total_mismatch` warning (svc:670-678). In v1 and v2 it is the
only amount compared: `subtotalMinor` and `taxMinor` are only type- and
range-checked (payload-shape.ts:52, value-ranges.ts:39), so a difference
from the server's subtotal or tax passes silently, with no warning and
nothing stored (vendurepos/app#38).
In v3, `taxMinor` must also equal `display.taxMinor` and Σ
`taxByRate[].taxMinor` (fiscal-figures.ts:93, 95), and each rate's tax
is compared with Vendure's, a difference of more than half a minor unit
per line and surcharge (rounded up) giving a `tax_rate_mismatch` warning
(svc:680-699); v3 `subtotalMinor` is only range-checked, as in v1 and
v2. vendurepos/app#38 decided the next step; see the §5 bullet on
subtotal and tax warnings.

## Consequences

**Spike S1 comes first.** On vendure-dev, with the vendored contract code,
it proves each of these with a test:

1. **Tax parity.** With the widened bound, the discount surcharges give
   order totals and per-rate tax within tolerance of the POS figures. This
   covers all four combinations of pricing mode and tax strategy, mixed
   per-line `taxInclusive` orders, and negative ties.
2. **No promotions.** After the re-pricing calls the recipe makes
   (`addItemToOrder`, `setShippingMethod`), the final pass saves
   `order.promotions` and every line's adjustments empty. The recipe avoids
   `addSurchargeToOrder` and `addPaymentToOrder` altogether.
3. **No customer email** for a POS order.
4. **Storefront.** The `tally-pos` payment method and the in-store shipping
   method are unusable from the Shop API.
5. **Error results.** A returned `ErrorResult` rolls the order back. S1
   exercised `OrderStateTransitionError` and the stock rollback; VP1 covers
   the other types under the error classes in §2.
6. **Batches.** Each command in a batch gets its own transaction, and a
   batch stops at a 409.
7. **Stock.** After the stock lock, a copied-context probe of the configured
   `StockLocationStrategy` chooses the first planned location if its plan covers q,
   otherwise `defaultStockLocation`. The top-up is `max(0, q − saleable)` before
   `addItemToOrder`, and saleable is then checked to be ≥ q. The thin POS-only
   wrapper caps the delegated plan cumulatively at q and fills any remainder at
   the default location. After `PaymentSettled`, Σ allocations must equal each
   POS line's quantity; both checks refuse as unstored `store_configuration`.
   Fulfilment draws where allocated, and each top-up is taken back at its own
   location. Storefront plans are unchanged. The `insufficient_stock` warning is
   emitted only for positive `max(0, q − max(0, onHand − allocated))`.
   It is the units of this sale not covered by physical stock, never more than q
   and never counting the out-of-stock threshold; a pre-existing negative on-hand
   is store state, not this sale's shortfall, and the till learns it through stock
   sync, not the warning (Front desk, 2026-09-29).
   A threshold under-allocation's remainder goes to the default location even
   when that location has no physical stock, per the ruling.
   The `insufficient_stock` warning is aggregate over the channel's locations.
8. **Lines.** POS lines stay 1:1 with order lines, including two lines of
   the same variant.
9. **Tenders.** Split tender and overpayment: the payments cover the order
   exactly, and `tallyPayments` holds the tenders as given, with change.
10. **Stored rejections.** A disabled variant gives a stored `unknown_variant`,
    and a channel whose default-zone tax rates are all disabled gives
    `store_configuration` (a Vendure 3.7.3 channel always has a tax zone);
    neither leads to a 503 retry loop.
11. **Idempotency.** A concurrent duplicate id gives 409 and then
    `duplicate`, and a new id for an existing `clientOrderId` returns the
    existing refs (as `applied` in the spike, following medusapos) and
    writes nothing.
12. **Crash safety.** A crash after commit leaves no duplicate order on
    retry.
13. **Upstream Vendure 3.7.3 findings (for Paul, not posted).** Split-allocation
    Sale rows record the full line quantity (`stock-movement.service.js:167-171`);
    MultiChannel over-allocates by using the full requested quantity at each
    location (`multi-channel-stock-location-strategy.js:87-113`). Tests measure
    per-location stock levels rather than Sale-row sums.
    MultiChannel's per-ctx stock-level cache makes a second same-variant line in
    one order allocate from pre-allocation levels (`multi-channel-stock-location-strategy.js`
    `getStockLevelsForVariant`). The plugin works around it for POS lines by
    allocating each on a copied context.

S1's results and numbers are in `docs/spikes/s1-order-recipe.md`.

**Follow-ups (Front desk):**
- **The warning contract.** `tax_rate_mismatch`, and `bridgeMinor` on
  `total_mismatch`, arrive in TallyUI's `CommandWarning` (2.2.0).
- ~~**Several stock locations.**~~ Closed by VP3-3: the strategy probe, POS-only
  allocation wrapper and both checks cover the configured `StockLocationStrategy`.
- ~~**A real email transport.**~~ Closed by VP2b.
  `packages/vendure-plugin/test/email-smtp.e2e.ts` sends through real SMTP
  to Mailpit. A storefront order is emailed once, and a POS order is not.
- ~~**Concurrent sales of one variant.**~~ Closed for concurrent POS sales by VP3-2. Vendure's own stock writers (storefront checkout, admin fulfilment, cancellation restocks, admin stock edits) stay unlocked read-modify-writes upstream, so a storefront or admin stock write alongside a POS sale can still lose an update, and a storefront order touching the same variants in another order can deadlock with a POS sale (a retried 503 `transient`, kind `deadlock`). Vendure's
  stock update is an unlocked read-modify-write, and VP3 measured 5 of 6
  concurrent updates lost. The recipe now locks every `stock_level` row of
  the sale's variants (`FOR UPDATE`, in variant then location order, 5 s,
  a timeout is a 503) before its first stock read, and `adjustStock` locks
  its own row, which covers an admin's take-back.
  `packages/vendure-plugin/test/concurrency.e2e.ts` proves it.
- **Split tender with change on a non-final tender.** VP1 adds this test.
- **The handler guard.** `ctx.apiType === 'custom'` holds for any plugin's
  REST controller; VP1 narrows the guard to this route.

Other consequences:

- The plugin needs no lease, fencing token, advisory lock or resume code.
  The ADR-051 KPI is still measured, not assumed.
- **The app cannot send v3 yet.** The published `@tallyui/*` 2.0.0 types
  know only command versions 1 and 2, so v3 waits for the next TallyUI 2.x
  publish. The plugin accepts all three, so nothing blocks on it.
- A Vendure 3.8 change to draft orders or the order process would land in
  one plugin file. `compatibility: '^3.6.0'` stays until it is tested.
- Distribution (npm scope, trusted publishing) follows the plan's ADR-054
  and is not decided here.
