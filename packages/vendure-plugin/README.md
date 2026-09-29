# @vendurepos/plugin

The VendurePOS server plugin for [Vendure](https://vendure.io). It records TallyUI's
`order.create` command (versions 1–3) as a Vendure order, in one database transaction per
command, with an idempotency ledger. The design is ADR 0002
(`docs/adr/0002-order-path-vendure-plugin.md`), proven by spike S1
(`docs/spikes/s1-order-recipe.md`).

Status: VP1. The plugin has the order service and `GET /tally/v1/info`. The batch route
`POST /tally/v1/commands` arrives in VP2.

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
