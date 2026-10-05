# @vendurepos/plugin

The VendurePOS server plugin for [Vendure](https://vendure.io). It records TallyUI's
`order.create` command (versions 1–3) as a Vendure order, in one database transaction per
command, with an idempotency ledger. The design is ADR 0002
(`docs/adr/0002-order-path-vendure-plugin.md`), proven by spike S1
(`docs/spikes/s1-order-recipe.md`).

Status: VP2a. The plugin serves `POST /tally/v1/commands` (`X-Tally-Protocol: 1`, 1–50
commands, a 1 MiB (1,048,576-byte) body (`COMMANDS_BODY_MAX_BYTES`)) and `GET /tally/v1/info`, both behind `Permission.CreateOrder`.

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
`npm install @vendurepos/plugin@0.1.0`.

1. Add the plugin to your Vendure config. If using the bundled migrations instead
   of generating a migration for your store, register all three below; do not run
   both approaches for the same schema changes:

   ```ts
   import {
     TallyPosPlugin, TallyPos1790648006022, TallyPosVp2a1790720000000, TallyPosRegister1790800000000,
   } from '@vendurepos/plugin';

   export const config: VendureConfig = {
     plugins: [TallyPosPlugin /* , … */],
     dbConnectionOptions: {
       type: 'postgres',
       synchronize: false,
       migrations: [
         TallyPos1790648006022, TallyPosVp2a1790720000000, TallyPosRegister1790800000000,
         /* your own migrations */
       ],
       // …
     },
   };
   ```

   The migrations create the `tally_command` ledger, the read-only `Order` and `OrderLine`
   custom-field columns, the unique index on `tallyClientOrderId`, and plain indexes on
   `tallyRegisterId` and `tallySessionId`, recovery fields, and the register tables.
   Run them with `runMigrations(config)` before starting Vendure.

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
