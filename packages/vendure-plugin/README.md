# @vendurepos/plugin

The VendurePOS server plugin for [Vendure](https://vendure.io). It records TallyUI's
`order.create` command (versions 1–3) as a Vendure order, in one database transaction per
command, with an idempotency ledger. The design is ADR 0002
(`docs/adr/0002-order-path-vendure-plugin.md`), proven by spike S1
(`docs/spikes/s1-order-recipe.md`).

Status: VP2a. The plugin serves `POST /tally/v1/commands` (`X-Tally-Protocol: 1`, 1–50
commands, a 1 MB body) and `GET /tally/v1/info`, both behind `Permission.CreateOrder`.

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
until an admin calls `OrderCreateService.resolveNeedsAdmin`. Either resolution takes the leftover
top-up back at the stock location recorded when it was made. Rejecting also cancels the POS
payments and the order with Vendure's own cancellation, releases its client id (kept in
`tallyRejectedClientOrderId`) and flags it `tallyRejected`; if a step fails, it is refused and
changes nothing. **An order flagged `tallyRejected` counts as never placed**: leave it out of any
register or sales figure; the till's Retry makes the sale that counts.

## Requirements

- Vendure `^3.6.0` (tested on 3.7.3), with `@vendure/email-plugin` if you send email.
- **Postgres only.** The ledger claim relies on Postgres semantics: `INSERT … ON CONFLICT`
  waits on another transaction's uncommitted row, and `SET LOCAL lock_timeout` bounds that
  wait. MySQL, MariaDB and SQLite are not supported.

## Installation

1. Add the plugin to your Vendure config:

   ```ts
   import { TallyPosPlugin, TallyPos1790648006022, TallyPosVp2a1790720000000 } from '@vendurepos/plugin';

   export const config: VendureConfig = {
     plugins: [TallyPosPlugin /* , … */],
     dbConnectionOptions: {
       type: 'postgres',
       synchronize: false,
       migrations: [TallyPos1790648006022, TallyPosVp2a1790720000000 /* , your own migrations */],
       // …
     },
   };
   ```

   The migration creates the `tally_command` ledger, the read-only `Order` and `OrderLine`
   custom-field columns, the unique index on `tallyClientOrderId`, and plain indexes on
   `tallyRegisterId` and `tallySessionId`. Run it with `runMigrations(config)` as usual.

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

## Development

The package is standalone npm, not part of the pnpm workspace.

```sh
npm ci
npm run db:up       # Postgres 16 on 127.0.0.1:5445, compose project vendurepos-plugin-test
npm run typecheck
npm run build       # dist/, with the main and ./email entries
npm test            # vitest, one worker
npm run db:down     # removes the container and its volume
```
