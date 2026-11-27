# Changelog

## Unreleased

### Added

- Register reads carry the live session's `openVersion` (VP-B). `GET /tally/v1/registers/:id` and `GET /tally/v1/registers` return it: the register contract version of the open that created the session, or `null` for a session stored before the plugin kept it, which the store treats as 1. After you set `registerApproval`, read it and take over every live session below 3 or `null` from a version 3 till. The README's #332 known limit gives the order and what the reads cannot show: the list's cap of 100 registers, and a `closed` session whose closure is not yet submitted. This replaces the #332 limit "the register read does not show which live sessions opened below version 3". Additive at read version 1. No migration: the column has existed since `TallyPosRegisterOpenVersion`.

## 0.6.0 (2026-11-27)

**Version pairing:** serve 0.6.0 only once the VendurePOS app from vendurepos/app#537 on is deployed. That app is on @tallyui 5.3.0 and forwards connector-vendure's `discountsAreTaxedRows` to every "Needs attention" reader, so it lists a bridged sale only when the bridge is over ADR-048's tolerance T, with discounted lines counted.
- A till on @tallyui 5.2.0, or on 5.3.0 without app#537, lists every bridge over the T without discounted lines, ⌈(lines + fees + shipping)/2⌉.
- A till on a @tallyui older than 5.2.0 lists every bridged sale under "Needs attention".
- The plugin cannot tell which till is calling, so it cannot gate this. A till still running an older bundle sees the new `warnings` until it reloads the deployed app.
- `order.create` replays from the ledger return the stored answer. A sale applied before the upgrade replays with its old `warnings`.

### Upgrading

- **From 0.5.0:** no migrations, no new permissions and no new options. The changes below apply as soon as 0.6.0 serves.

### Added

- Each fee and shipping charge can carry its own tax mode (v2 parity 2.10b, ADR 0005 amendment).
  - `order.create`'s `fees[]` and `shipping[]` entries accept an optional `amountIncludesTax: boolean`, with `amountMinor` in that mode. A non-boolean value is refused `invalid_payload`.
  - The plugin stores the charge in that mode, so a charge entered including tax in a tax-exclusive store totals to the cent with Vendure. Before, it was re-taxed from a converted net, and the TALLY-ROUNDING bridge covered a one-cent drift with a `total_mismatch` warning.
  - `/tally/v1/info` advertises `chargeTaxMode: { v: 1 }`.
  - Without the field, behaviour is unchanged. No migration.

### Changed

- `order.create` sends each `tax_rate_mismatch` in `warnings` as well as in `totalWarnings`. It is the same object (vendurepos/app#530). The till parses it, shows its notice, and lists the applied sale under "Needs attention".
- `order.create` sends a bridged `total_mismatch` in `warnings` as well as in `totalWarnings` (vendurepos/app#537). It has the same figures, and it comes before any `tax_rate_mismatch`, as in `totalWarnings`. See the version pairing above.
- The per-rate tolerance T for `tax_rate_mismatch` is now counted from the payload: ⌈(lines + fees + shipping + lines with `discountMinor` > 0)/2⌉ (vendurepos/app#532). This is the same T as TallyUI ADR-048 and @tallyui/pos `needsAttention`.
  - Before, T counted the saved order's lines and surcharges. That added the TALLY-ROUNDING bridge row and Vendure's always-present shipping line.
  - T is now lower or equal on those orders, so a per-rate drift that used to pass silently can raise `tax_rate_mismatch`.
  - The bridge bound (money P3 #7) keeps its own count.

### Deprecated

- `totalWarnings`. Read `warnings`, which now carries every entry in it. `totalWarnings` is still sent, unchanged, and will be removed in a later release.

### Fixed

- A refund that takes everything left on the lines is now refused, unstored, as `rounding_exceeds_rest` when the order's negative rounding (TALLY-ROUNDING plus TALLY-CASH-ROUNDING) brings it to 0 or less (vendurepos/app#526, #469).
  - It carries `{ roundingMinor, restMinor }`. `restMinor` is the refund's total before that rounding, shipping and adjustment included.
  - Before, a sum of exactly 0 was refused `nothing_to_refund`, and the till told the cashier to pick an item. A sum below 0 was refused `amount_mismatch`.
  - The app from vendurepos/app#526 on says to refund the rest in Vendure admin. An older till shows its generic refusal with the code.
  - No figure changes.

## 0.5.0 (2026-11-26)

**0.4.0 was never published to npm.** Its version and changelog were merged on 2026-11-23, but it was not tagged. The first version on npm after 0.3.0 is 0.5.0, and it includes everything listed under 0.4.0 below.

**Version pairing:** the VendurePOS app on @tallyui 5.1.0 or later rounds cash only against a plugin whose `/tally/v1/info` advertises `cashRounding`, which needs 0.5.0. Against 0.4.0 or older, the till takes exact cash and keeps no local-only rounding (ADR 0009 item 7). The 0.4.0 pairing still applies: the app from vendurepos/app#466 on needs 0.4.0 or later.

### Upgrading

- **From 0.4.0:** no migrations and no new permissions. The behaviour changes below apply as soon as 0.5.0 serves.
- **From 0.3.0:** run the six migrations listed under 0.4.0, in its order, before serving 0.5.0. 0.5.0 adds none of its own. The 0.4.0 permissions and its handler behaviour change apply too.

### Added

- Cash rounding (TallyUI ADR-094, docs/adr/0009-cash-rounding.md).
  - A Tally cash payment method takes a rounding increment (minor units) and a mode: nearest, up or down. The method's `/tally/v1/info` entry lists both, and `/info` advertises `cashRounding: { v: 1 }`.
  - `order.create` accepts `payload.cashRoundings` (`{ paymentId, minor }[]`) at every content version. It checks the entries against the channel's enabled rounding cash methods and stores their sum as one untaxed `POS cash rounding` surcharge (SKU `TALLY-CASH-ROUNDING`), so the order total is what the till took. The TALLY-ROUNDING bridge reconciles the goods total only.
  - Refused, unstored:
    - a malformed entry;
    - payments that do not add up to `totalMinor`;
    - a rounding cash leg that is not a multiple of its increment;
    - more than one entry, or a non-negative one, on any other payment;
    - no enabled rounding cash method;
    - an entry of 2 × the largest enabled increment or more, unless the running sum of entries through it is under that or, for the last entry, the entry plus some prefix of the entries before it is (a reopened sale's settle, TallyUI#1367). An accepted sale's net rounding is at most 16 × (B − 1), with B twice the largest increment. This one is refused `total_mismatch` with `cashRoundingMinor` and `boundMinor`, and its message names void cycles (TallyUI#1365).
  - An entry whose running sum (the entries through it, in payload order) is outside its rounding mode's range is applied, and it raises `cash_rounding_unexplained`: a result warning, `tallySnapshot.cashRoundingUnexplained` and a private order note, which names the running sum at each such payment and the allowed range in minor units. The ranges are nearest (−inc/2, inc/2], up [0, inc) and down (−inc, 0]. A carried pick that brings the sum back inside is silent.
  - The refund that takes everything left on an order's lines returns its cash rounding, as it returns the bridge; no other refund returns any of it. That refund command records the cash part (never the bridge) as `tallyCashRoundingMinor` in its first Vendure Refund's metadata; the key is absent when there is none.
  - `GET /tally/v1/reports/sales/v4`, beside the unchanged v1, v2 and v3: v3's report plus `cashRounding` with `salesMinor`, `orderCount`, `unexplainedOrderCount` (sales stored with `cash_rounding_unexplained`, including any whose entries net to 0), `refundedMinor`, `refundCount` and `netMinor`. Every v3 filter applies, and refunds are dated by the refund. A refund without `tallyCashRoundingMinor`, such as one made in the Vendure dashboard, counts the sale's cash rounding as returned when it is the refund that brings the sale's non-failed refunds up to its settled payments and no refund of that sale carries the key. This is worked out when the report is read; nothing is stored (#513). It is a breakdown: the amounts are already inside `orders.salesMinor` and `refunds.totalMinor`.

### Behaviour change

- Every command (`order.create`, `order.refund` and the register commands) now refuses a string value holding a lone UTF-16 surrogate (half of an emoji, say) as `invalid_payload`, `<path>: must not contain a lone surrogate`; nothing is stored (#515). The check runs after the replay read, so a command that holds one and was already recorded before this release still replays its recorded answer. A string holding U+0000 is still refused before any database access with the U+0000 message. A valid pair, such as `😀`, is applied as before.
- A lone surrogate already stored (a refund's `cashierRef`, a tender reference, a ledger result) no longer 500s a read (#515). Before, one such refund failed every sales report v1–v4 over its range, the register session that holds it and every later refund lookup, and one such rejected register command failed every approval by `closureId` in its channel. Each stored lone surrogate now reads as U+FFFD (`�`), so a report filtered by that refund's `cashierId` no longer finds it under the original value. Well-formed data reads exactly as before.
- The sales report's `orders.discountsMinor` (v1, v2 and v3 routes) is now gross: the tax-inclusive amount taken off the receipt, as `salesMinor` is. It is computed when the report is read, from each POS discount's tax lines; no stored data changes. Past ranges change on stores with tax-exclusive prices and for every sale from a v4+ till, where the figure was net before. Lines a v2/v3 till sent tax-inclusive are unchanged. On a store using Vendure's `OrderLevelTaxCalculationStrategy`, which rounds tax once per rate group, Discounts can differ from what came off the order total by up to 1 minor unit per tax rate in the order.
- `order.create` takes the channel's default currency only. A sale in another currency the channel offers is now refused `unsupported_currency` (before, it was accepted and its amounts were added to the register's expected figures as if they were the default currency, while the sales report left it out). Nothing is stored, so the same command applies once its currency is the channel's default; a command already recorded still replays its recorded answer. A sale in another currency still queued on a till is refused on every resend until that currency is the channel's default. A store that sells in several currencies needs one channel per currency.
- `order.create` refuses a till total that is off by more than rounding. When the till's `totalMinor` differs from Vendure's total by more than max(2, one per order line) minor units (order lines are product lines, surcharges and shipping lines), the sale is refused `total_mismatch` with `expectedMinor`, `serverMinor`, `bridgeMinor` and `boundMinor` in `error.data` (before, any difference was bridged by a `POS rounding` surcharge and only warned). Nothing is stored: the sale rolls back and the same command is checked again on resend, and the server logs one `total_mismatch` warning line per refusal. Every command version is bounded; a command already recorded still replays its recorded answer. A difference within the bound is still bridged with a `total_mismatch` warning, as before.

## 0.4.0 (2026-11-23)

**Version pairing:** the VendurePOS app from vendurepos/app#466 on needs plugin 0.4.0 or later. Against 0.3.0, the final refund of a sale with a rounding bridge is refused, and nothing is refunded. Update the plugin before or with the app.

### Upgrading from 0.3.0

Run the migrations (Vendure's `runMigrations`, or the server with `migrationsRun`) before serving 0.4.0. All six are additive: they create tables and add nullable columns, and they change no existing row (the sixth fills its new table from `tally_display`, which the third creates). They run in this order:

1. `TallyPosRegisterV21791000000000`: `deviceId`, `deviceName` and `supersedes` on `tally_register_session`, a unique `(channelId, supersedes)` constraint, and the `tally_register_session_alias` table. Sessions opened before it have no device id and can only be taken over, not resumed.
2. `TallyPosRegisterOpenVersion1791100000000`: `openVersion` on `tally_register_session`.
3. `TallyPosDisplay1791200000000`: the six customer-display tables (`tally_display`, `tally_display_code`, `tally_display_pending`, `tally_display_snapshot`, `tally_display_signal`, `tally_display_claim_window`).
4. `TallyPosRegisterApproval1791300000000`: the `tally_register_approval` table and `approvalId` on `tally_register_closure`.
5. `TallyPosReceiptEmail1791400000000`: the `tally_receipt_email_window` table.
6. `TallyPosDisplayDevice1791500000000`: the `tally_display_device` table, with a row for each device already in `tally_display`.

New permissions (none of them opens the `/tally/v1` routes, which still need `TallyPosSell` or `CreateOrder`):

- `TallyPosRefund`: refund a sale at a till. SuperAdmin holds it; the till role preset does not, so add it to a till's role for till refunds.
- `ApproveTallyPosVariance`: approve a register close over the variance threshold, and see expected figures in a blind close. SuperAdmin holds it.
- `TallyPosPairDisplay`: pair a customer display. The till role preset holds it; a role made from the preset under 0.3.0 does not gain it until **New POS till key** runs again.
- `TallyPosResetDisplayDevice`: reset a till's customer-display device. SuperAdmin holds it; the till role preset does not.

**Behaviour change:** the `tally-pos` payment handler now settles every refund at once. An admin refund of a POS order used to stay `Pending` until someone settled it by hand. It is now `Settled` when made, carries no till metadata, and counts in no register session.

### Changes

- Over-tender (money P2 #3, #468): an order written by 0.4.0 stores the total its tenders were capped against (`totalMinor` in `tallySnapshot`). The register's expected figures cap an over-tender to it, so a sale books only what applied, and the app's stored receipt caps to it too. Orders sold before 0.4.0 have no `totalMinor`: the register reads them uncapped, as before. No migration.
- Customer display reset (9.8e): a new permission, `TallyPosResetDisplayDevice` (SuperAdmin holds it; the till role preset does not), opens two Admin API operations in the active channel: `tallyDisplayDevices` lists the customer-display devices with their displays and no secrets, and `tallyResetDisplayDevice(deviceId)` deletes a device with every display, code and pending pairing it owns, so the id registers again with a new key (`DeletionResponse`, `NOT_DELETED` for an unknown id). No migration.
- Blind close (4.3d): `register_approval_required`'s `data` gains `closureId`, and a caller without `ApproveTallyPosVariance` no longer receives its `data.variance` (fresh or replayed; a holder still does, and the ledger keeps it). `POST /tally/v1/register-approvals` takes exactly one of `variance` or `closureId`; with `closureId` it approves the variance stored with that closure's newest refusal for the session in this channel, or answers 404 `approval_request_unknown`. Both or neither answer 400 `invalid_payload`. No migration.
- Blind close (4.3c): a caller without `ApproveTallyPosVariance` on the active channel (SuperAdmin holds it) no longer receives `GET /tally/v1/registers/:id`'s `session.expected`, `session.paidInMinor` and `session.paidOutMinor`, nor each closure item's `expected`, `variance`, `tillExpected`, `paidInMinor` and `paidOutMinor`, nor a register command reply's `session.expected` or `closure.expected` and `closure.variance` (fresh or replayed). The keys are omitted; movement amounts, floats and `register_approval_required`'s `data.variance` are still sent, and the command ledger still stores every figure. No migration.
- Receipt email: a cap of 0 (`perOrder`, `perUserPerDay` or `perChannelPerDay`) refuses every send with its usual 429 code and no `retryAt`; before, it let one send through per window (#347).
- Dashboard: an order with till custom lines shows a **Till custom items** block after its order lines, listing each line's custom name, SKU, quantity and price with tax, as the stock table titles them all "POS custom item" (ADR 0005 ruling (a)). Needs ReadOrder. No migration.
- The till role preset (`tallyEnsurePosTillRole`) gains `UpdateCustomer`, so a till can edit a customer; it still holds no `DeleteCustomer`. An existing `vendurepos-pos-till` role gains it the next time **New POS till key** runs (or `tallyEnsurePosTillRole` is called), keeping the merchant's own additions, or a merchant can add Update customer to the role under Settings → Roles. No migration.
- Receipt email: the per-order cap and the new daily caps (perUserPerDay, perChannelPerDay) are kept in the database (migration TallyPosReceiptEmail1791400000000), so they hold across restarts and server instances (#345).
- `POST /tally/v1/variants/:id/stock` sets a variant's saleable stock only while it still equals the figure the till showed, under the same stock lock as a sale (10.2).
- The receipt-email route's per-user rate limit keeps at most 10,000 users in memory, dropping the least recently seen (#318).
- Dashboard: **POS sales to resolve** shows each sale's channel by its code. **Cancel the sale** says when the Dashboard is in another channel, offers a switch to the sale's channel and stays disabled until they match, as the server cancels only from the sale's channel. No migration.
- `GET /tally/v1/registers/:id`: the live `session` gains `movements` (every movement of the session, oldest first) and `paidInMinor` and `paidOutMinor` (the cash paid in and out its `expected` counts), additive at version 1. No migration.
- Dashboard: **POS sales to resolve** (Sales, SuperAdmin only) lists the sales kept `needs_admin` and resolves each with a note: **Keep the sale** (`applied`) or **Cancel the sale** (`rejected`), through the existing `tallyNeedsAdminCommands` and `tallyResolveNeedsAdmin`. No migration.
- `POST /tally/v1/orders/:code/receipt-email` (12.1a): with `TallyPosPlugin.init({ receiptEmail: true })` and `tallyReceiptEmailHandler` (`@vendurepos/plugin/email`) installed, a till sale's receipt is emailed on request (needs ReadOrder as well), to the order's customer or a given `emailAddress`, with the order-confirmation template; `GET /tally/v1/info` advertises `receiptEmail: { v: 1 }`; one plain address only, at most `perOrder` sends per order (default 3) and `perUserPerMinute` requests per user (default 20), each answering 429. No migration.
- `GET /tally/v1/registers/:id`: each closure item gains `countedFloatMinor`, `paidInMinor` and `paidOutMinor` (the session's float and the cash paid in and out its `expected` counted), additive at version 1. No migration.
- Customer-display pairing and signalling (TallyUI ADR-085 U7): the till-side `/tally/v1/displays` routes and the public, token-gated `/tally/v1/display` routes implement TallyUI's `DisplaySignalling` seam. A new permission, `TallyPosPairDisplay`, opens the till side only; the till role preset holds it, and roles made from the preset earlier do not gain it. Migration `TallyPosDisplay1791200000000` adds the six `tally_display_*` tables. `GET /tally/v1/info` advertises `customerDisplay`, with `iceServers` from the new `TallyPosPlugin.init({ customerDisplay })` option. Failed claims are limited per `req.ip`, so a server behind a proxy must set `trust proxy`.
- `GET /tally/v1/reports/sales/v2`, beside the unchanged v1: v1's figures plus `orders.itemCount`, `refunds.orderCount`, `orderCount` and `refundCount` per method, `byHour` rows in the query's time zone, the top 100 `products` (with `productsTruncated`) and `taxes` rows summed from Vendure's own tax summary. An optional `cashierId` filters every figure by the sale's till cashier (a till refund by its own cashier). It needs `TallyPosSell` and `ReadOrder`, as v1 does.
- order.create versions 6 and 7 (ADR-077, ADR-083): `GET /tally/v1/info` advertises order.create 1–7. A v7 sale's `note` is kept as one public order note in the order's history (Vendure's `addNoteToOrder`, in the sale's transaction; a replay adds none). v6's coupons and Any picks are refused `invalid_payload`; its regular prices and line attributes are accepted as display only and change no amount.
- `GET /tally/v1/registers` lists the active channel's registers, newest session first, at most 100: each register's id and `receivedAt`, its last session's `deviceName` as `lastDeviceName`, and its live session (`status`, `openedAt`, `openedBy`, `deviceName`) or `null`. It needs `TallyPosSell` or `CreateOrder`, as `GET /tally/v1/registers/:id` does. No migration.
- `order.refund` v1 at `POST /tally/v1/commands` (ADR 0007): a till refunds a till sale through Vendure's own `refundOrder`, attributed to its open register session, and restocks through stock cancellations. `GET /tally/v1/info` advertises `order.refund: [1]`. Register figures count the session's refunds: expected cash and external fall, and `perpetualRefundsTotalMinor` is no longer 0. A refund is priced as each line's share of its line total, so a whole line refunds exactly its total.
- **Behaviour change:** the `tally-pos` payment handler settles every refund at once. An admin refund of a POS order used to stay `Pending` until someone settled it by hand; it is now `Settled` when made, carries no till metadata and counts in no register session.
- An `order.refund` whose `clientRefundId` a refund that is not `Failed` already carries is refused `invalid_payload`.
- The till role preset (`tallyEnsurePosTillRole`) gains `ReadOrder`, so a till can list the store's order history. An existing `vendurepos-pos-till` role gains it the next time **New POS till key** runs, and keeps the merchant's own additions.
- A third custom permission, `TallyPosRefund` (`tallyPosRefund`): it may refund a sale at a till with `order.refund`, which refuses a till without it `forbidden`. The SuperAdmin role holds it, and the till role preset (`tallyEnsurePosTillRole`) does not. It never opens the `/tally/v1` routes.
- A second custom permission, `ApproveTallyPosVariance` (`tallyPosApproveVariance`): it may approve a register close over the variance threshold. The SuperAdmin role holds it. Nothing checks it yet, and it never opens the `/tally/v1` routes, which still need `TallyPosSell` or `CreateOrder`.
- A command on a superseded session is refused `register_session_superseded` when the command or the session's own open is version 2, so a till that sends later register commands at version 1 (TallyUI 3.8.0) still learns it was taken over; `register_session_closed` stays for a v1 command on a session opened at v1. Migration `TallyPosRegisterOpenVersion1791100000000` adds `openVersion` to `tally_register_session`.
- Register contract version 2 (ADR 0006): `GET /tally/v1/info` advertises register 1–2. A v2 `register.session.open` records the till's `deviceId` and `deviceName`. The device holding the live session resumes it; a different session id becomes a permanent alias and the result carries `resumed`. Another device takes over with `supersedes` naming the live session, a compare-and-set under the register lock.
- Register commands resolve session aliases. A command on a superseded session is refused `register_session_superseded` at v2 and `register_session_closed` at v1, and a v2 open naming a superseded session gets the same v2 refusal. The live `expected` and `salesCount` count sales carrying an alias.
- A v1 open from the device holding the live session, naming that session's id, is applied with the current figures.
- order.create v3 and later naming a session the store does not know is applied with a `register_session_unknown` warning.
- Migration `TallyPosRegisterV21791000000000` adds `deviceId`, `deviceName` and `supersedes` to `tally_register_session`, the `tally_register_session_alias` table and a unique `(channelId, supersedes)` constraint. Sessions opened before the migration have no device id and can only be taken over, not resumed. Run its `down` only on a store that never served a v2 open.

## 0.3.0 (2026-10-06)

- `GET /tally/v1/info` advertises order.create 1–5 (ADR 0005).
- order.create v5 custom lines are real order lines on a plugin-owned, disabled 'POS custom item' variant (SKU `TALLY-CUSTOM-ITEM`, category 'POS no tax'), created per channel at bootstrap; the till's name and SKU are on the line (`tallyCustomName`, `tallyCustomSku`) (ADR 0005).
- order.create v5 shipping: one charge per order, applied as the order's ShippingLine (`tally-in-store`, priced from the `tallyShipping` order custom field); a second entry is refused as `shipping_single` (ADR 0005).
- `GET /tally/v1/info` returns `maxShippingLines: 1` and `lineTax: { none: true, classes: true }`.
- Migration `TallyPosV51790900000000` adds the v5 custom fields (`order.tallyShipping`, `order_line.tallyCustomName`, `order_line.tallyCustomSku`).
- order.create v5 fees are applied as Vendure Surcharges (`TALLY-FEE`), taxed by `taxStatus`/`taxClass`; an unknown `taxClass` is refused as `tax_class_unknown` (ADR 0005).

## 0.2.0 (2026-10-06)

- The **New POS till key** dialog names the channel the key works in; Vendure's API keys are channel-aware.
- `GET /tally/v1/info` returns `device: { name }` (the API key's name) when the caller signs in with an API key, and leaves it out for sessions; the till shows it as its cashier (ADR 0004).
- Dashboard extension: **New POS till key** on Vendure's API keys page creates a named key with the POS till role and shows it once (ADR 0004).
- Add the `TallyPosSell` permission. The `/tally/v1` routes accept it or `CreateOrder`, so existing installs keep working with no role change; give new tills' administrators `TallyPosSell` instead of the broader `CreateOrder`.
- Admin API: `tallyNeedsAdminCommands` lists sales kept for an admin, and `tallyResolveNeedsAdmin(commandId, applied | rejected, note)` resolves one; both SuperAdmin only (#116).
- order.create v4 results carry a `figures_mismatch` warning when the till's subtotal, tax or discount differs from the store's (#117).
- Admin API: `tallyEnsurePosTillRole` (SuperAdmin) creates or extends the `vendurepos-pos-till` role: `TallyPosSell`, `ReadCatalog`, `ReadSettings`, `ReadCustomer`, `CreateCustomer` (exported as `POS_TILL_PERMISSIONS`), in every channel. It never removes a permission or channel. With Vendure's API keys (`tokenMethod` including `'api-key'`), a key with this role does everything a till does (ADR 0004).

## 0.1.0 (2026-10-01)

- Accept `order.create` v1–v4 at `POST /tally/v1/commands`, with one Postgres
  transaction per command and durable idempotent replay. Record POS prices,
  customers, payments, fulfilment and sale time; bridge tax-rounding differences.
  v2 adds discounts, v3 receipt/tax snapshots, session and customer references,
  and v4 makes every discount tax-exclusive.
- Accept all five register commands at v1: `register.session.open`,
  `register.session.transition`, `register.movement.record`,
  `register.movement.void` and `register.closure.submit`. Store sessions,
  movements and immutable closures with expected amounts, variance and counters.
- Expose authenticated `GET /tally/v1/info`, advertising `order.create` v1–v4,
  register v1 and the store's tax-rounding strategy.
- Lock stock-level rows in a stable order for POS sales and Vendure's
  order-driven stock writes. Support multi-location allocation, shortage
  warnings and stock top-up recovery. Direct stock-level writes and an admin's
  absolute stock set remain outside the strategy lock.
- Require strict RFC 3339 client times with `Z` or an offset, from
  `2020-01-01T00:00:00Z` through the server clock plus 24 hours; replay committed
  results before validating new time bounds. Preserve the client's sale time.
- Include migrations `TallyPos1790648006022` (ledger, order/line fields and
  indexes), `TallyPosVp2a1790720000000` (recovery fields), and
  `TallyPosRegister1790800000000` (register tables and nullable ledger order id).

<!-- Sources: docs/adr/0002-order-path-vendure-plugin.md; docs/adr/0003-register-commands.md; packages/vendure-plugin/src/migrations/; git log packages/vendure-plugin (43c67cd, 67e6477, dd873d7, aca6df3, e40c093, 8a4751b). -->
