# The order path: `order.create` v3 as one transaction per command in a Vendure plugin

Status: Accepted (2026-09-29, on spike S1's results: `docs/spikes/s1-order-recipe.md`)
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

### 2. Transactions, idempotency and error classes

**One transaction per command, never per batch.** The controller has no
`@Transaction()`:

1. It first validates every envelope in the batch (`validateBatch`).
2. It then runs the pre-claim checks for each command. A shape or version
   refusal (`invalid_payload`, `unsupported_version`) and a store that
   cannot take the sale (`store_configuration`: no tax zone, no `tally-pos`
   payment method, no in-store shipping method) are answered here, before
   any write or claim.
3. It runs each remaining command in its own `withTransaction`.
4. It stops at the first 409 or 503, as medusapos's `process.ts` does.
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
  it answers 409 `in_progress`, which the outbox retries. The timeout is
  reset right after the claim, so it does not also govern the stock and
  order locks that follow.
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

**Error classes** (Front desk ruling 1, VP2; TallyUI ADR-038's
`platform_error` amendment). The table is `src/service/classification.ts`,
with a test per row.

- **Deterministic refusals come before the claim** (Front desk ruling A).
  An unknown or disabled variant (`unknown_variant`), payments below
  `totalMinor` (`underpaid`), the configured order limits
  (`invalid_payload`) and the permanent-list configuration errors (a missing
  manual fulfilment handler, a replaced checker on the POS payment or
  shipping method: `store_configuration`) are answered before any write, so
  they emit no event, and they are not stored. After the claim only races
  and `internal_error` reach the savepoint path below. Their events leak:
  Vendure's EventBus waits only for the outer transaction, so the events a
  rolled-back savepoint emitted are delivered when the rejection commits,
  for an order that does not exist. `tallyOrderConfirmationHandler`
  ignores them (it ignores every POS order), and the README warns
  merchants' own subscribers.
- **The savepoint keeps the claim.** After the claim, the sale's steps run
  in a savepoint inside the command's transaction (Vendure's
  `withTransaction` inside a transaction). A stored outcome rolls back to
  the savepoint, stores the rejection on the claim row and commits. A
  rejection is never committed together with any of the sale's writes, and
  never written in a separate transaction after a full rollback, so a resend
  of the same id waits on the claim (409) and never runs the recipe twice.
- **Stored rejections**, replayed without re-running the recipe:
  - `unknown_variant` for a variant disabled or removed during the sale;
  - `underpaid` when the `PaymentSettled` transition is refused and the
    payments really are below the bridged total (a safety net);
  - `insufficient_stock` if a shortage survives the top-up;
  - `platform_error` only for an `ErrorResult` on the plugin's explicit
    permanent list (one that depends only on the payload and the store's
    configuration), as `platformErrorResult` shapes it. State-dependent
    errors (a state transition, stock, a declined payment) are not on it;
  - `internal_error` only for a `PluginBugError`, which the plugin raises
    explicitly where one of its own invariants breaks, after the claim and
    the complete rollback of the sale, with a generic message and a
    correlation id. Any native error, the plugin's own `TypeError`
    included, is transient; nothing parses stacks.
- **Unclassifiable is transient.** Any other `ErrorResult`, and every
  database, driver, network or unknown-SQLSTATE error, answers 503 and
  stores nothing; the claim is released and the till resends the same id.
  Only the claim's own lock timeout answers 409. A refused `PaymentSettled`
  transition whose payments do cover the total counts as
  `store_configuration` (not stored) when a configuration cause is found,
  and otherwise as transient.
- **The collision guard.** A `clientOrderId` this channel has already
  recorded, whether found before the recipe or through a unique violation
  on `tallyClientOrderId`, answers `applied` only when the order's own
  command row is `applied`: the new command id is then stored as `applied`
  with that result's refs and warnings, and replays as `duplicate`. A row
  that is `needs_admin` answers 409, and so does a sale still in progress,
  whose unique key the new command waits on for the claim's 5 s. A new
  command id never gets round a 409 or an admin mark. In another channel,
  the collision is a stored `idempotency_mismatch`, including from the
  default channel, where Vendure also places every channel's orders: the
  order's own command row decides whose sale it is.
- **`needs_admin`.** The one compensating write is the stock take-back
  after fulfilment, in a savepoint of its own. If it fails, the plugin
  never answers `platform_error` and never releases the claim: the sale
  commits, the row is marked `needs_admin`, `Logger.error` names the
  command id, and every resend answers 409 `in_progress`. An admin resolves
  the row as `applied` or `rejected` with
  `OrderCreateService.resolveNeedsAdmin`, and replays then answer that.
  `rejected` (`platform_error`, `platformCode: 'TALLY_ADMIN_REJECTED'`)
  takes back the top-up the failed take-back left, cancels the settled
  `tally-pos` payments, cancels the order with Vendure's `cancelOrder`,
  which restores its stock, and frees its `clientOrderId` (a truncated
  prefix and a hash of the command id, within 255 characters), all in the
  rejection's transaction; if any step fails, the rejection is refused and
  nothing changes. A rejected row never
  keeps a live order, so the till's Retry under a new id is a new sale.

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
| Currency | `ctx.currencyCode` is set from `payload.currency` before any line is added. A currency the channel does not offer is refused as `unsupported_currency` before the claim. Like `store_configuration`, that refusal is not stored, so the same command id applies once the channel is fixed. S1 did not prove this; VP1 implements and tests it | Repricing lines in the channel's default currency |
| Lines | One `OrderLine` per POS line. Vendure merges equal lines, so a read-only line custom field `tallyClientLineId` keeps them 1:1 | — |
| Stock | A manual fulfilment records `SALE` stock movements at the location that Vendure's `StockLocationStrategy` allocates from. `payload.locationId` is not used in the MVP (TallyUI does not send it yet). A shortage is topped up **before** `addItemToOrder`, because otherwise `addItemToOrder` saves the line at the saleable quantity and returns `InsufficientStockError` (and `addItemsToOrder` cuts it silently; S1), and before `ArrangingPayment`. The top-up is taken back after fulfilment, inside the transaction, and the result carries an `insufficient_stock` warning (ADR-039) | Stock-reduction hooks and reservation tables |
| As-sold price and tax mode | An `OrderItemPriceCalculationStrategy` that wraps the configured one. Only on orders with `tallyClientOrderId`, it returns the read-only line custom field `tallyUnitPrice`, with `priceIncludesTax` set to the line's own mode (`lines[].taxInclusive`, falling back to the order's `pricesIncludeTax`), which it reads from a second read-only line field, `tallyPriceIncludesTax`, because the strategy sees only the order and the line's custom fields. Vendure's `PriceCalculationResult` carries both, so per-line tax mode needs no other workaround (proved in S1) | Rewriting line totals through post meta |
| Discounts (v2/v3) | One negative, **taxable** `Surcharge` per discounted line (`POS discount`, SKU `TALLY-DISCOUNT`) of `-discountMinor`, in that line's tax mode. Its tax lines copy the line's rate and description, so the order-level tax group for that rate shrinks by the discount. A net unit price was rejected: `(unit × qty − discount) / qty` is not an integer in general | Coupon emulation |
| Server promotions | **None on POS orders.** The POS has already applied its own discounts. Four calls re-apply the channel's active promotions while the order is built: `addItemsToOrder`, `addSurchargeToOrder`, `setShippingMethod`, and the coupon revalidation inside `addPaymentToOrder`. So the recipe ends with one final pricing pass, `orderCalculator.applyPriceAdjustments(ctx, order, [])`, followed by explicit saves of the order, its lines and its shipping lines. `order.promotions` and every line's promotion adjustments are saved empty. A later edit in the Dashboard would re-apply the channel's promotions; POS orders are not meant to be edited there | Settling promotion differences in a surcharge |
| Tax and money authority | The configured `TaxZoneStrategy` and the merchant's tax strategy, unchanged. **The till's totals are the fiscal record** (as in medusapos ADR 0012). One untaxed `TALLY-ROUNDING` surcharge bridges **any** difference between Vendure's total and `totalMinor` (ADR-048). The order is always recorded, and is never refused as `total_mismatch`. The size of the bridge comes back as a `totalWarnings` entry. The surcharge is added through the repository followed by `calculateOrderTotals`, so it causes no promotion pass. The plugin rounds no money itself: the bridge is an integer difference, and the tolerance is a ceiling. Any division the plugin does add rounds half away from zero. Vendure's own tax rounding is accepted as it is: it uses `Math.round`, so −59.5 on a negative surcharge becomes −59. The bridge and the tolerance absorb the difference (Front desk ruling, after S1). ADR-048's bound widens to ⌈(lines + surcharges) / 2⌉ minor units, and S1 asserts that the bridge never exceeds it in any parity case. Per-rate figures are compared with that tolerance against the v3 `taxByRate`, and any difference is reported as a warning, never refused | WooCommerce's single "prices include tax" option, and changing store settings to match the POS |
| Payment | One shared `tally-pos` `PaymentMethod`, assigned to every channel. Its handler returns `Settled` payments created with `PaymentService.createPayment`, one per tender (`cash` or `external`) as given. A sum of tenders above the total is allowed (ADR-039): the covering tender's Vendure payment is capped, so Vendure accepts the payments as covering the order exactly. The **full tender list, including change, is stored on the order** in a read-only `tallyPayments` field, as medusapos's `tally_payments` is. That list is the fiscal record, and a register's expected cash derives from it, never from Vendure's payment rows. A zero-total sale has no payment, so the plugin makes the `PaymentSettled` transition itself | Payment-gateway emulation |
| Collection | One shared in-store `tally-in-store` `ShippingMethod` with a zero calculator, assigned to every channel | Hiding shipping lines |
| Closed to the storefront | The `tally-pos` payment method and the in-store shipping method each have an eligibility checker that accepts only orders carrying `tallyClientOrderId` created through the plugin's authenticated route. The payment handler also refuses unless `ctx.apiType === 'custom'`. A Shop API customer can never settle an order with `tally-pos` or pick the in-store method | — |
| Customer | In order: the customer from `customer.customerId` (v3) when it exists in this channel; else the customer found or created by email with `CustomerService.createOrUpdate` (ADR-047); else one walk-in placeholder customer per channel. An unknown or foreign `customerId` falls back; it never rejects the sale | Guest-order meta |
| No customer email | POS orders send no order-confirmation email, matching Medusa's `no_notification`. The plugin exports a wrapped `orderConfirmationHandler` that skips orders with `tallyClientOrderId`, and the quick-start tells merchants to install it in their `EmailPlugin` handlers. In 3.7.3 the order confirmation fires on `OrderStateTransitionEvent` to `PaymentSettled`. S1 proved the filter with a testing transport; the first plugin e2e proves it with a real transport | — |
| Till, drawer and cashier | Order custom fields: `tallyRegisterId` is the till's **device** id (medusapos ADR 0017/0019); `tallySessionId` (v3) identifies the drawer session (ADR-068); `tallyCashierRef`; `tallySaleAt`. Register sessions, movements and closures are their own commands and entities later (ADR-068); the order only references them. TallyUI records the device meaning in ADR-038/068 | `_wcpos_register`, `_wcpos_session` and `_pos_user` post meta; the WooCommerce sale counter, which TallyUI's payload does not carry and this plugin does not add |
| Receipt snapshot (v3) | `display` and `taxByRate` are stored unchanged in a read-only `Order.tallySnapshot` text field, so the order carries the receipt exactly as the cashier printed it | Rebuilding a receipt from server totals |
| Order number | Vendure's own order `code`, returned as `serverRefs.displayId` | — |

**Custom fields.** All are read-only in the Admin API. Vendure enforces that
only at the API layer, so the plugin writes them directly. `unique` gives
`tallyClientOrderId` its index. The plugin's migration adds plain indexes on
`tallyRegisterId` and `tallySessionId`, because custom fields have no index
option.

**Store configuration.** There is one shared `tally-pos` payment method and
one shared `tally-in-store` shipping method, created once in the default
channel and assigned to every channel, and a walk-in customer per channel.
A bootstrap creates or assigns them when they are missing. If one is still missing when a sale arrives, or the channel
has no tax zone, the sale is refused as `store_configuration` before the
claim, and the till retries it by hand after the store is repaired.

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
  pinned by ADR-065's `order-create-v3.json` fixture;
- a higher version gets `unsupported_version` with `data.orderCreate: 3`
  before the claim;
- v1 and v2 orders simply have no snapshot or session id.

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
7. **Stock.** The top-up happens before `addItemToOrder`, and the sold
   quantity is never cut.
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

S1's results and numbers are in `docs/spikes/s1-order-recipe.md`.

**Follow-ups (Front desk):**
- **The warning contract.** `tax_rate_mismatch`, and `bridgeMinor` on
  `total_mismatch`, arrive in TallyUI's `CommandWarning` (2.2.0).
- **Several stock locations.** VP3 takes the top-up location from
  `StockLocationStrategy`; S1 used the default location.
- **A real email transport.** The first plugin e2e exercises the wrapped
  email handler with one.
- **Concurrent sales of one variant.** Vendure's stock update is an
  unlocked read-modify-write, and the top-up and take-back double that
  exposure. VP3 measures it under concurrency.
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
