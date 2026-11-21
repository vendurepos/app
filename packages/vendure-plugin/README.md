# @vendurepos/plugin

The VendurePOS server plugin for [Vendure](https://vendure.io). It records TallyUI's
`order.create` command (versions 1–7) as a Vendure order, in one database transaction per
command, with an idempotency ledger. The design is ADR 0002
(`docs/adr/0002-order-path-vendure-plugin.md`), proven by spike S1
(`docs/spikes/s1-order-recipe.md`).

The plugin serves `POST /tally/v1/commands` (`X-Tally-Protocol: 1`, 1–50
commands, a 1 MiB (1,048,576-byte) body (`COMMANDS_BODY_MAX_BYTES`)) and `GET /tally/v1/info`, both behind the plugin's `TallyPosSell` permission or `Permission.CreateOrder` (either is enough). The plugin also declares `ApproveTallyPosVariance` for managers who approve a close over the variance threshold. It opens neither route, and nothing checks it until the approval route lands. It also declares `TallyPosRefund`, which the coming `order.refund` command will check. It opens neither route either, and the till role preset leaves it out: a store grants refunds to the roles it chooses. medusapos ADR 0023's `UseTallyPos` is `TallyPosSell` (or `CreateOrder`) here. These permission names are public API once a role stores them, so they are never renamed.

**Rejections and events.** Every deterministic refusal is answered before the sale writes anything,
so it emits no event. A command already in the ledger always replays its recorded answer first. A
malformed or out-of-range payload (`invalid_payload`: shape, amounts, quantities, fiscal figures, a `createdAt` more than a day ahead) is refused before any claim and not stored. The
state-dependent facts about the sale (`unknown_variant`, `underpaid`) are stored on the command's
ledger claim. The store's setup (`store_configuration`, including the order limits
`orderItemsLimit` and `orderLineItemsLimit`, and `unsupported_currency`) is not stored, so the same
command applies once the store is fixed. Once the sale has started writing (Vendure publishes its first event there), a
failure rolls the whole transaction back as a transient 503 and Vendure drops the events it had
emitted; the resend is checked again. A plugin bug before that point is a stored `internal_error`.

**Needs an admin.** A sale whose stock take-back fails, or that a plugin bug stops part-way, is
kept as far as it got and marked `needs_admin` in the `tally_command` ledger; it answers 409
until an admin resolves it through the Admin API. `tallyNeedsAdminCommands` lists the waiting sales;
`tallyResolveNeedsAdmin(commandId, resolution: applied | rejected, note)` resolves one. Both need
SuperAdmin; a rejection must be sent with the sale's channel token (`vendure-token`). Either resolution takes the leftover
top-up back at the stock location recorded when it was made. Rejecting also cancels the POS
payments and the order with Vendure's own cancellation, releases its client id (kept in
`tallyRejectedClientOrderId`) and flags it `tallyRejected`; if a step fails, it is refused and
changes nothing. **An order flagged `tallyRejected` counts as never placed**: leave it out of any
register or sales figure; the till's Retry makes the sale that counts.

```graphql
mutation {
  tallyResolveNeedsAdmin(commandId: "command-id", resolution: applied, note: "checked the till") {
    id
    status
  }
}
```

## Requirements

- Vendure `^3.6.0` (tested on 3.7.3), with `@vendure/email-plugin` if you send email.
- **Postgres only.** The ledger claim relies on Postgres semantics: `INSERT … ON CONFLICT`
  waits on another transaction's uncommitted row, and `SET LOCAL lock_timeout` bounds that
  wait. MySQL, MariaDB and SQLite are not supported.

## Installation

Follow the [quick-start](https://github.com/vendurepos/app/blob/main/docs/QUICKSTART.md) for migration generation, bearer
auth, CORS, tax strategy and a first sale. Install it with
`npm install @vendurepos/plugin@0.3.0`.

1. Add the plugin to your Vendure config. If using the bundled migrations instead
   of generating a migration for your store, register all nine below; do not run
   both approaches for the same schema changes:

   ```ts
   import {
     TallyPosPlugin, TallyPos1790648006022, TallyPosVp2a1790720000000, TallyPosRegister1790800000000,
     TallyPosV51790900000000, TallyPosRegisterV21791000000000, TallyPosRegisterOpenVersion1791100000000,
     TallyPosDisplay1791200000000, TallyPosRegisterApproval1791300000000, TallyPosReceiptEmail1791400000000,
   } from '@vendurepos/plugin';

   export const config: VendureConfig = {
     plugins: [TallyPosPlugin /* , … */],
     dbConnectionOptions: {
       type: 'postgres',
       synchronize: false,
       migrations: [
         TallyPos1790648006022, TallyPosVp2a1790720000000, TallyPosRegister1790800000000,
         TallyPosV51790900000000, TallyPosRegisterV21791000000000, TallyPosRegisterOpenVersion1791100000000,
         TallyPosDisplay1791200000000, TallyPosRegisterApproval1791300000000, TallyPosReceiptEmail1791400000000,
         /* your own migrations */
       ],
       // …
     },
   };
   ```

   The migrations create the `tally_command` ledger, the read-only `Order` and `OrderLine`
   custom-field columns, the unique index on `tallyClientOrderId`, and plain indexes on
   `tallyRegisterId` and `tallySessionId`, recovery fields, the register tables, the customer-display tables and the receipt-email limit table.
   Run them with `runMigrations(config)` before starting Vendure.
   Upgrading to `TallyPosReceiptEmail1791400000000`: run the migration before starting the new version. During a rolling deploy, instances still on the old version count receipt emails in their own memory until they stop, so the caps hold exactly only once every instance runs the new version.
   To roll back, revert the plugin version and leave the `tally_receipt_email_window` table in place: the old version ignores it. To remove the table as well, stop every instance, run this migration's `down` with the new version's package (the old package does not contain the migration), then start the old version; never drop the table by hand, or its `migrations` row stays and a later upgrade skips the migration.

2. POS orders send no order-confirmation email. If you use `@vendure/email-plugin` (an
   optional peer dependency), install `tallyOrderConfirmationHandler` from the
   `@vendurepos/plugin/email` entry **in place of** `orderConfirmationHandler`. It is a handler
   of its own with the default's configuration, and it leaves the default handler unchanged:

   ```ts
   import { EmailPlugin, defaultEmailHandlers, orderConfirmationHandler } from '@vendure/email-plugin';
   import { tallyOrderConfirmationHandler } from '@vendurepos/plugin/email';

   EmailPlugin.init({
     handlers: defaultEmailHandlers.map(handler =>
       handler === orderConfirmationHandler ? tallyOrderConfirmationHandler : handler),
     // …
   });
   ```

   The main entry, `@vendurepos/plugin`, never loads `@vendure/email-plugin`.

On start, in the server process, the plugin gives every channel that lacks them the
`tally-pos` payment method, the `tally-in-store` shipping method and the walk-in customer.
Both methods are closed to the Shop API. A channel created later is configured at the next
start.

### The POS methods across channels

Each method is created **once**, in the default channel, and assigned to every other channel.
The default channel's Admin UI therefore lists one `tally-pos` and one `tally-in-store`, shared
by all channels, not a copy per channel. Deleting them follows Vendure's own rules:

- **`tally-pos`, deleted in the default channel:** Vendure refuses (`NOT_DELETED`, naming the
  other channels that use it) unless the deletion is forced. A forced deletion removes the method
  from every channel.
- **`tally-pos`, deleted in another channel:** Vendure removes it from that channel only.
- **`tally-in-store`, deleted in any channel:** Vendure soft-deletes a shipping method as a whole,
  so it is gone from **every** channel, the default channel included.

A channel without either method answers every new sale with `store_configuration`, before the
claim and without storing anything. The next server start creates or assigns the missing method
again, and the same commands then apply.

### Merchant code inside the recipe

Each command runs in one database transaction. A refusal found inside it (`underpaid`,
`insufficient_stock`, `platform_error`, `internal_error`) rolls the transaction back and is
stored as final; the till may then retry the sale under a new command id. Merchant code that runs
inside that transaction — custom order-process hooks, blocking event handlers, custom
strategies — must therefore not write outside the transaction or call outside systems (email,
payment providers, webhooks, other databases). Otherwise such a side effect survives the
rollback, and a `platform_error` or a retry can follow a side effect that has already happened.

POS lines keep the till's price; every other order line is priced by your configured
`orderItemPriceCalculationStrategy`, which the plugin wraps and whose `init` and `destroy` it
forwards.

### Optional: an index for POS customer lookups

A sale with an email finds its customer with `LOWER("emailAddress") = LOWER($1)` among customers
that are not deleted, so customers stored with any case match. Vendure has no index for that, so
each such lookup is a sequential scan of the `customer` table. Walk-in sales (no email) skip it
after the first walk-in sale in each process.
The plugin never adds an index to Vendure's own table itself (ADR 0002, ruling 16). Add this one
yourself when the store has **more than about 50,000 customers**, or when POS sales with an email
are visibly slow:

```sql
CREATE INDEX CONCURRENTLY "IDX_customer_email_lower" ON "customer" (lower("emailAddress")) WHERE "deletedAt" IS NULL;
```

`CONCURRENTLY` builds the index without blocking writes to `customer`, and so it must run
**outside a transaction**: run it on its own in `psql`, not inside a migration that TypeORM wraps in
a transaction. If it fails part-way, it leaves an `INVALID` index; drop that and run it again. To
remove the index:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "IDX_customer_email_lower";
```

Vendure's `generateMigration` (tested with Vendure 3.7.3 and TypeORM 0.3.31) does not see this
expression index, so it neither drops nor re-adds it. On start, the server process logs one warning when `customer` holds more than
50,000 rows (the planner's estimate) and has no `lower("emailAddress")` index.

### Dashboard: a key for each till

With Vendure's React Dashboard, the API keys page (Settings → API keys) gains **New POS till key**.
It creates or extends the `vendurepos-pos-till` role, creates a named key with it, and shows the key once. The role sells through the plugin, reads the catalogue, the store settings, customers and orders, and creates and edits customers (never deletes them); extending an existing role adds what it lacks and keeps the merchant's own additions.

A role made from the preset before `UpdateCustomer` was in it (plugin 0.3.x and earlier) gains it the next time **New POS till key** runs, or add Update customer to the role under Settings → Roles. Until then the till shows no Edit on a customer.

The key works only in the channel the Dashboard is in when you create it (Vendure's API keys are channel-aware), so switch to the till's channel first. The dialog names it.

Rotate and delete stay on Vendure's own key page. The till signs in with the key only when
`authOptions.tokenMethod` includes `'api-key'` (ADR 0004).

Sales → **POS sales to resolve** lists the till sales kept for an admin (`needs_admin`) and keeps or cancels each one, with a note.
The page and its nav item are SuperAdmin only, as the `tallyNeedsAdminCommands` and `tallyResolveNeedsAdmin` calls behind them are.

With npm, the Dashboard build finds the button by itself. With pnpm, the Dashboard looks for
plugins inside `node_modules/.pnpm` and misses it, so point `vendureDashboardPlugin` at the
project's `node_modules` (tested with Vendure 3.7.3):

```ts
vendureDashboardPlugin({
  // ...
  pluginPackageScanner: { nodeModulesRoot: path.resolve(__dirname, 'node_modules') },
}),
```

### order.create version 5: fees, shipping and custom lines

- Fees are Vendure Surcharges (`TALLY-FEE`).
- One shipping charge per order is recorded as the order's shipping line; a second is refused (`shipping_single`).
- Custom lines are order lines on the plugin's disabled "POS custom item" product (SKU `TALLY-CUSTOM-ITEM`), with the till's name on the line.
- "POS no tax" is a plugin-owned tax category for untaxed lines.
- `taxClass` is matched to a tax category by name, then id. Without one, the store's **default** category is used. If none is marked default, the fee is refused, so mark one in Settings → Tax categories.
- Run the bundled migration `TallyPosV51790900000000`, or generate your own, before starting 0.3.0.

### order.create versions 6 and 7: the sale note

Version 7 adds the sale's `note` (at most 1000 characters). It is written to the order as one public order note,
which the order's history in the Admin shows. Version 6's coupons and Any picks are refused as `invalid_payload`;
its regular prices and line attributes are accepted for display and change no amount.

### Register version 2: resume, take-over and unknown sessions

The plugin answers register contract versions 1 to 3 (`/tally/v1/info` lists `"register": [1, 2, 3]`); version 3 is below. The design is ADR 0006 (`docs/adr/0006-register-v2.md`), after TallyUI ADR-078.

- Every open records the till's `deviceId`; a version 2 open also records `deviceName`.
- **Resume.** A version 2 open from the till that holds the register's live session resumes that session instead of opening a new one. The id the till sent becomes a permanent alias: later commands and orders naming it act on the live session, and its sales count in the live figures.
- **Take-over.** A version 2 open with `supersedes` naming the live session takes the register over, in one transaction under the register's lock. Naming anything else is refused `register_session_already_open` with the live session's details. The old session is refused every later command with `register_session_superseded`, whatever the command's version (TallyUI#515, #333).
- **Unknown sessions.** An `order.create` naming a session the store does not hold is applied, with the warning `register_session_unknown`. The order keeps the id, and a session opened later under it counts the sale.
- Run the bundled migration `TallyPosRegisterV21791000000000`, or generate your own, before a till sends register version 2. Its `down` is safe only on a store that never served a version 2 open (ADR 0006, Consequences).
- Run `TallyPosRegisterOpenVersion1791100000000` before a till sends register version 2; sessions opened before it answer a v1 command on a taken-over session with `register_session_closed`.

### Register version 3: a manager approves a close over the variance threshold

Off by default. Set `TallyPosPlugin.init({ registerApproval: { thresholdMinor } })` only once your tills run a VendurePOS app version that asks a manager for approval; until then a close over the threshold cannot complete. Run the bundled migration `TallyPosRegisterApproval1791300000000`, or generate your own, first.

- With the option set, `GET /tally/v1/info` holds `registerApproval: { thresholdMinor }`. A version 3 closure whose cash variance is over the threshold (either way) is refused `register_approval_required` with `{ sessionId, thresholdMinor, variance }`. The variance is the server's: counted cash minus the float, the received sales the closure lists and the synced movements. It is not the till's own expected figure.
- **The manager's proof.** `POST /tally/v1/register-approvals` with `{ sessionId, variance, username, password }`, sent by the till's cashier, checks a Dashboard administrator's credentials without logging them in. The administrator needs `ApproveTallyPosVariance` (or SuperAdmin) on the session's channel. It answers 200 `{ approval, approvedBy, approvedByName, expiresAt }`. The refusals are:
  - 401 `approval_invalid_credentials`, the same answer for an unknown user and a wrong password;
  - 403 `approval_forbidden`;
  - 404 `approval_session_unknown`;
  - 409 `approval_session_closed`, once the session is superseded or has a closure;
  - 429 `approval_rate_limited`, after 5 failures from one cashier or 10 for one username in 15 minutes;
  - 400 `invalid_payload`.
- The till resends the closure with `approval`. The proof is good for 15 minutes, once, for that session and that variance. Otherwise the closure is refused `register_approval_invalid` with `reason` `unknown`, `used`, `expired`, `session_mismatch` or `variance_mismatch`. The store keeps only the proof's hash.
- A version 3 closure's `approvedBy` is the approving administrator's user id, never a name the till sends, and the register read shows `approvalVerified: true`. Every other closure reads `approvalVerified: false`: older ones, version 1 and 2 ones (whose `approvedBy` is the till's unverified label), and version 3 ones under the threshold or with the option off.
- **New sessions open at version 3 (#334).** While the option is set, a version 1 or 2 `register.session.open` that would create a session, a take-over included, is refused `unsupported_version` with `{ register: 3 }`. Nothing is stored, so the same command can be resent at version 3. A version 1 or 2 open that resumes the till's own live session still applies, and an open stored before the option was set replays as stored.
- **Known limits (#332).** A session that was already open at version 1 or 2 when the option was set finishes at its own version: closed at version 1 or 2, it is not held to the threshold, and its close reads `approvalVerified: false` (a version 3 closure of it is held). The register read does not show which live sessions opened below version 3, so when you set the option, close or take over the sessions that are open. The server's expected figure counts only the sales and movements the closure lists. An approval request that ends in 403, or whose credential check throws, still counts as a failure toward the rate limits.

### Register read: GET /tally/v1/registers/:id

A till or back office reads one register of the active channel, to show or reprint past Z reports from the server. The route needs the same permission as the command route (`TallyPosSell` or `CreateOrder`) and writes nothing.

- The answer is `{ version: 1, register, counters, session, closures }`. `session` is the live session, or `null` when none is open. `closures` is `{ items, totalItems, skip, take }`, newest first, each item with the figures frozen at `register.closure.submit`.
- Each closure item also carries `countedFloatMinor` (its session's opening float), `paidInMinor` and `paidOutMinor`: the `paid_in` and `paid_out` movements in its `movementIds` that its `expected` counted, skipping each one voided by a void in that same list. The three fields are additive at version 1.
- A live `session` also carries `movements`, every movement of the session oldest first (`id`, `type`, `amountMinor`, `reason`, `voids`, `createdAt`, `createdBy`), and `paidInMinor` and `paidOutMinor` over all of them under the closure item's rule, all additive at version 1.
- `skip` (default 0) and `take` (default 20, at most 100) page the closures. Any other value answers 400 `invalid_query`.
- A register the channel does not hold, including another channel's, answers 404 `register_not_found`.
- `/tally/v1/info` does not list the route. A plugin without it answers 404 with Vendure's own body.

### Sales report: GET /tally/v1/reports/sales

The active channel's POS sales and refunds in a time range, every figure a SQL aggregate in integer minor units.

- The caller needs both `TallyPosSell` and `ReadOrder`; with only one it gets 403 `forbidden`. The till role preset has both.
- `from` (inclusive) and `to` (exclusive) are ISO date-times with an offset, at most 366 days apart. `registerId` (optional) narrows the report to one register. `timezone` (an IANA zone, default `UTC`) sets only the day buckets. A bad parameter answers 400 `invalid_query`.
- Only orders in the channel's default currency count, so totals never mix currencies; the answer names that currency.
- A refund counts on the date it was made, which may be outside its sale's range. Figures are gross; no net-of-refunds figure is given.
- The answer's top-level keys are `version` (1), `from`, `to`, `timezone`, `currencyCode`, `registerId`, `orders` (count, sales, tax, discounts), `refunds` (count, total), `byMethod` and `byDay`.
- `/tally/v1/info` does not list the route. Its shape is this plugin's own until TallyUI has a report contract.

### Receipt email: POST /tally/v1/orders/:code/receipt-email

A cashier's explicit request (12.1a), not ADR 0002's automatic confirmation: set `TallyPosPlugin.init({ receiptEmail: true })` and install `tallyReceiptEmailHandler` from `@vendurepos/plugin/email` beside `tallyOrderConfirmationHandler` in `EmailPlugin`'s handlers; `GET /tally/v1/info` then holds `receiptEmail: { v: 1 }`. It renders with your existing order-confirmation template, subject `Receipt for order #<code>`. The body is `{ emailAddress? }`; without it, the order customer's email is used. `emailAddress` is one plain address only: no list, display name, quotes, line break, encoded words or IP addresses. Answers: 202 `{ queued: true, emailAddress }` (each request sends one email), 404 `receipt_email_disabled`, 403 `forbidden` (the user lacks `ReadOrder`), 400 `invalid_payload`, 404 `order_not_found`, 409 `not_till_order`, 422 `no_recipient` (a walk-in sale and no address, or a stored email that is not one plain address), 429 `rate_limited` (more than `perUserPerMinute` requests from one user in a minute, refusals included; default 20), 429 `order_send_limit` (the order already had `perOrder` receipts sent in the 30 days from its first; default 3), 429 `user_daily_limit` (the user already had `perUserPerDay` receipts sent; default 500) and 429 `channel_daily_limit` (the channel already had `perChannelPerDay` receipts sent, by all its users together; default 1000). Each daily window is 24 hours from its first send, and only accepted sends count towards these three caps; each of their 429s carries `retryAt`, the time a send can next pass. A cap of 0 refuses every send, and its 429 has no `retryAt`, as no send will ever pass; to turn the route off, use `receiptEmail: false`. Override the caps with `TallyPosPlugin.init({ receiptEmail: { perOrder: 3, perUserPerMinute: 20, perUserPerDay: 500, perChannelPerDay: 1000 } })` (the defaults). The per-minute count is kept in memory, per server process; the per-order and daily counts are kept in the database, so they hold across restarts and across server instances. It changes no customer or order.

### Stock edit: POST /tally/v1/variants/:id/stock

The till's stock edit (10.2): it sets a variant's saleable stock only while the store's figure still equals the one the till showed, under the same stock lock as a sale. It needs `UpdateCatalog` or `UpdateProduct`, as Vendure's `updateProductVariants` does. `:id` is the Admin API's variant id. The body is strictly `{ expectedSaleable, saleable }`, both whole numbers from 0 to 2,147,483,647 (Postgres int4). Saleable is `max(stockOnHand − stockAllocated − threshold, 0)`, the threshold being the global `outOfStockThreshold` unless the variant opts out; on-hand is written as `saleable + stockAllocated + threshold` through Vendure's own stock adjustment.

| Status | Body | When |
|---|---|---|
| 200 | `{ saleable, stockOnHand }` | written, or nothing to change |
| 400 | `invalid_payload` | a bad body |
| 403 | Vendure's own FORBIDDEN | no `UpdateCatalog` or `UpdateProduct` |
| 404 | `variant_not_found` | the variant is not in the active channel |
| 409 | `stock_level_not_single` | the variant does not have exactly one stock level at the active channel's stock locations |
| 409 | `stock_changed` `{ code, message, saleable }` | the figure changed; `saleable` is the store's current figure |
| 503 | `stock_busy` | a sale held the stock past the lock timeout; nothing is written |

`/tally/v1/info` does not list the route; a plugin without it answers 404 with Vendure's own body, which has no `code`.

### Customer display: pairing and signalling

A till can pair a customer display on a second device (TallyUI ADR-085). The till-side routes under
`/tally/v1/displays` need the `TallyPosPairDisplay` permission and nothing else: `TallyPosSell` and `CreateOrder`
do not open them. The display-side routes under `/tally/v1/display` are public and carry the display's own token. All
state is in Postgres, so any server instance answers any call.

- The till role preset (`tallyEnsurePosTillRole`) holds `TallyPosPairDisplay` from this version. A role created from
  the preset before it does not gain the permission: add it under Settings → Roles in the Vendure admin, or with the
  `updateRole` mutation, or by running `tallyEnsurePosTillRole` again, which adds the preset's permissions to the
  existing role.
- Failed claims are limited per source address, which is Express's `req.ip`. A server behind a proxy or load balancer
  must set `trust proxy` to the number of proxies in front of the server (for example `apiOptions.trustProxy: 1`)
  or to their addresses, never `true`: `true` takes the left-most `X-Forwarded-For`, which the client writes, so
  every guess would count as a new source. Without it every display shares the proxy's address as one source,
  which is stricter, never looser.
- `POST /tally/v1/displays/device` with `X-Tally-Device-Id` answers `200 { "deviceKey": "…" }` once per channel and
  device id; a repeat is `403 device_refused`. A device id that already had displays before this version adopts its
  displays at its first register, once. Every other till route needs `X-Tally-Device-Key` beside
  `X-Tally-Device-Id`; a missing, malformed or wrong key is `403 device_refused`. Only the key's SHA-256 is stored.
  A device that owns no display, code or pending pairing and makes no till call for over 30 days is dropped, and its
  id registers again.
- `GET /tally/v1/info` advertises `customerDisplay: { v: 1, snapshot: 1, iceServers? }`. Set the ICE servers with
  `TallyPosPlugin.init({ customerDisplay: { iceServers: [{ urls: 'stun:stun.example.com:3478' }] } })`; without the
  option the till uses its default STUN servers, and `[]` means LAN only.
- Anything in `iceServers`, static TURN credentials included, is visible to whoever can reach `/info`, so use
  short-lived TURN credentials or STUN only.

## Development

The package is standalone npm, not part of the pnpm workspace.

```sh
npm ci
npm run db:up       # Postgres 16 and Mailpit in a stack derived from this worktree's path
npm run typecheck
npm run build       # dist/, with the main and ./email entries
npm test            # vitest, one worker
npm run db:down     # removes the containers and the volume
```

`npm run db:up` derives a Compose project and ports from the absolute package directory, and
records the chosen stack in the ignored `.test-stack.env`, which the tests read. `db:down` uses
that recorded stack and removes the file after stopping it, so overrides do not need to be kept
for `db:down`. `scripts/test-stack.sh env` prints the values without starting it.
`db:up` with a different `PLUGIN_TEST_PROJECT` refuses while the recorded stack is running; run `npm run db:down` first.
The key is the path's `cksum`; the offset is `key % 100`.

| Environment variable | Stack default |
| --- | --- |
| `PLUGIN_TEST_PROJECT` | `vendurepos-plugin-${key}` |
| `PLUGIN_TEST_PG_PORT` | `5400 + offset`; advance past 5432 and 5442–5445, and past any port already listening on the host, wrapping 5499 to 5400 |
| `PLUGIN_TEST_SMTP_PORT` | `11000 + offset` |
| `PLUGIN_TEST_MAILPIT_PORT` | `18000 + offset` |
| `PLUGIN_TEST_SERVER_PORT` | `13000 + offset` |

Tests resolve each port from the environment, then `.test-stack.env`, then the CI/no-file defaults:
Postgres 5445, SMTP 1045, Mailpit API 8045 and Vendure server 3050. CI keeps its fixed services.
If paths hash to colliding ports, all four ports advance together to the first free offset.
To override the chosen stack, export values before `npm run db:up`, for example:

```sh
export PLUGIN_TEST_PROJECT=plugin-review PLUGIN_TEST_PG_PORT=5499
export PLUGIN_TEST_SMTP_PORT=11099 PLUGIN_TEST_MAILPIT_PORT=18099 PLUGIN_TEST_SERVER_PORT=13099
```

Build before `npm test`: `test/email-smtp.e2e.ts` imports `@vendurepos/plugin/email` from `dist/`, as a
store does, and sends through Mailpit. The dev store (`dev/vendure-store`) installs this package from
`dist/` too, so build it before that store's `npm ci`; the store's scripts do so when `dist/` is stale.
