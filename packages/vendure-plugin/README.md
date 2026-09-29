# @vendurepos/plugin

The VendurePOS server plugin for [Vendure](https://vendure.io). It records TallyUI's
`order.create` command (versions 1–3) as a Vendure order, in one database transaction per
command, with an idempotency ledger. The design is ADR 0002
(`docs/adr/0002-order-path-vendure-plugin.md`), proven by spike S1
(`docs/spikes/s1-order-recipe.md`).

Status: VP2a. The plugin serves `POST /tally/v1/commands` (`X-Tally-Protocol: 1`, 1–50
commands, a 1 MB body) and `GET /tally/v1/info`, both behind `Permission.CreateOrder`. A sale
whose stock take-back fails is marked `needs_admin` in the `tally_command` ledger and answers
409 until an admin calls `OrderCreateService.resolveNeedsAdmin`. Rejecting it cancels the order
with Vendure's own cancellation, or is refused if the order cannot be cancelled.

**Events of a rejected sale.** Every deterministic refusal (an unknown variant, an underpayment,
the order limits, the store's configuration) is answered before anything is written, so it emits
no event. A sale refused after that point (a race, such as stock that changed meanwhile, or a
plugin `internal_error`) is rolled back to a savepoint inside the command's transaction, but
Vendure's EventBus still delivers the events it emitted (`OrderStateTransitionEvent`,
`OrderPlacedEvent`, …) when the rejection commits, **for an order that does not exist**. The
plugin's `tallyOrderConfirmationHandler` ignores them, as it ignores every POS order; your own
subscribers should check that the order still exists.

## Requirements

- Vendure `^3.6.0` (tested on 3.7.3), with `@vendure/email-plugin` if you send email.
- **Postgres only.** The ledger claim relies on Postgres semantics: `INSERT … ON CONFLICT`
  waits on another transaction's uncommitted row, and `SET LOCAL lock_timeout` bounds that
  wait. MySQL, MariaDB and SQLite are not supported.

## Installation

1. Add the plugin to your Vendure config:

   ```ts
   import { TallyPosPlugin, TallyPos1790648006022 } from '@vendurepos/plugin';

   export const config: VendureConfig = {
     plugins: [TallyPosPlugin /* , … */],
     dbConnectionOptions: {
       type: 'postgres',
       synchronize: false,
       migrations: [TallyPos1790648006022 /* , your own migrations */],
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
