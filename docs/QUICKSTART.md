# VendurePOS quick-start

The hosted POS is live at `https://vendurepos.vercel.app`; the plugin install
still waits for the npm publish.
Start with a working Vendure 3.6+ project backed by **Postgres** (3.7.3 is the
tested version). Run store commands from that project's root.
<!-- Sources: docs/RELEASE-RUNBOOK.md; packages/vendure-plugin/package.json; packages/vendure-plugin/README.md (Requirements). -->

1. **Install the plugin.** This step waits for the 0.1.0 npm publish:

   ```sh
   npm install @vendurepos/plugin@0.1.0
   ```

   <!-- Sources: packages/vendure-plugin/package.json (name, version, peers); docs/RELEASE-RUNBOOK.md (publish gate). -->

2. **Add `TallyPosPlugin` to your existing Vendure config.** Keep your other
   plugins and settings. This plugin has no `.init()` options:

   ```ts
   import { TallyPosPlugin } from '@vendurepos/plugin';

   // Inside your existing VendureConfig:
   plugins: [/* your existing plugins, */ TallyPosPlugin],
   ```

   It registers the order custom fields, price and stock strategies, payment
   handler, and `/tally/v1/commands` and `/tally/v1/info` routes.
   <!-- Sources: packages/vendure-plugin/src/index.ts; packages/vendure-plugin/src/plugin.ts; dev/vendure-store/src/vendure-config.ts. -->

3. **Generate and run the migration before starting the server.** Keep
   `dbConnectionOptions.synchronize: false`. With the plugin added, use your
   project's migration runner to invoke Vendure's generator:

   ```ts
   import { generateMigration } from '@vendure/core';
   import { config } from './vendure-config';

   generateMigration(config, { name: 'AddVendurePos', outputDir: './src/migrations' })
     .catch(error => { console.error(error); process.exitCode = 1; });
   ```

   Run this TypeScript entry with your project's existing TypeScript runner.
   For projects scaffolded with `@vendure/create`, Vendure's CLI alternative is
   `npx vendure migrate` (generate and run interactively).
   Review the generated migration and include it in
   `config.dbConnectionOptions.migrations` (or your existing migration glob).
   Then run a separate entry with the same runner:

   ```ts
   import { runMigrations } from '@vendure/core';
   import { config } from './vendure-config';

   runMigrations(config)
     .catch(error => { console.error(error); process.exitCode = 1; });
   ```

   The schema includes the command ledger, order/line custom fields and indexes,
   stock top-up recovery fields, and register/session/movement/closure tables.
   Generate against your store's current schema. Do not also run the plugin's
   bundled migrations for the same changes; the README describes that alternative.
   <!-- Sources: packages/vendure-plugin/node_modules/@vendure/core/dist/migrate.d.ts; packages/vendure-plugin/src/config/custom-fields.ts; packages/vendure-plugin/src/migrations/1790648006022-TallyPos.ts; packages/vendure-plugin/src/migrations/1790720000000-TallyPosVp2a.ts; packages/vendure-plugin/src/migrations/1790800000000-TallyPosRegister.ts; packages/vendure-plugin/test/migration.e2e.ts. -->

4. **Enable bearer authentication.** Merge this into `authOptions`, retaining
   your credentials and other settings (and any other token methods you need):

   ```ts
   tokenMethod: ['bearer', 'cookie'],
   ```

   Sign in with a Vendure administrator who can read the channel's catalogue
   and settings and has `CreateOrder`; the plugin routes require that permission.
   <!-- Sources: dev/vendure-store/src/vendure-config.ts; docs/DISCOVERY.md §2.5; docs/adr/0002-order-path-vendure-plugin.md §1; apps/pos/lib/sign-in.ts. -->

5. **Allow the POS origin through CORS.** Add `https://vendurepos.vercel.app`
   to the scaffold's `CORS_ORIGINS` allowlist. Its production default allows no
   origins. Also allow the exact local POS origin for testing, for example
   `http://localhost:8081`. If configuring the object directly, merge this into
   `apiOptions` and retain any other allowed origins:

   ```ts
   cors: {
     origin: ['https://vendurepos.vercel.app', 'http://localhost:8081'],
     credentials: true,
   },
   ```

   Use an object, so Vendure exposes `vendure-auth-token` for bearer sign-in.
   Origins contain no path; `localhost` and `127.0.0.1` are different origins.
   <!-- Sources: docs/DISCOVERY.md §2.5; dev/vendure-store/src/vendure-config.ts; dev/vendure-store/src/constants.ts. -->

6. **Choose tax rounding for your pricing mode (ADR-048).** These settings
   are store-wide and also affect the web shop; the plugin does not choose them
   for you. Keep `DefaultTaxLineCalculationStrategy` for line tax and the default
   money strategy. Choose the **order** tax strategy as follows:

   | Channel pricing | `taxOptions.orderTaxCalculationStrategy` |
   | --- | --- |
   | Tax-exclusive (`pricesIncludeTax: false`) | `new OrderLevelTaxCalculationStrategy()` |
   | Tax-inclusive (`pricesIncludeTax: true`) | `new DefaultOrderTaxCalculationStrategy()` |

   For a tax-exclusive store, merge this into your config:

   ```ts
   import { DefaultTaxLineCalculationStrategy, OrderLevelTaxCalculationStrategy } from '@vendure/core';

   taxOptions: {
     taxLineCalculationStrategy: new DefaultTaxLineCalculationStrategy(),
     orderTaxCalculationStrategy: new OrderLevelTaxCalculationStrategy(),
   },
   ```

   For inclusive pricing, import `DefaultOrderTaxCalculationStrategy` from
   `@vendure/core` and use it for `orderTaxCalculationStrategy` instead. The
   single-rate totals match with these pairings; multiple rates can still need
   the plugin's rounding surcharge. A store mixing pricing modes must account
   for the store-wide strategy. `/tally/v1/info` advertises the actual rounding.
   <!-- Sources: docs/DISCOVERY.md §2.4.1; docs/PLAN.md §1 (ADR-048); dev/vendure-store/src/vendure-config.ts; packages/vendure-plugin/src/service/tax-rounding.ts; packages/vendure-plugin/src/api/info.controller.ts. -->

7. **Prepare the channel and stock, then restart Vendure.** Assign the products
   and stock locations to the channel you will use, with a usable default stock
   location. Check its currency, `pricesIncludeTax`, default tax zone and enabled
   tax rates (including a zero rate where appropriate). Keep the manual
   fulfilment handler enabled. The plugin uses Vendure's stock allocation
   strategy; a per-sale `locationId` is not supported.

   On server start the plugin creates or assigns the `tally-pos` payment method,
   `tally-in-store` shipping method and walk-in customer to each channel. Keep
   the POS payment method enabled and its handler/checkers intact. Restart after
   adding a channel so it receives this setup.
   <!-- Sources: packages/vendure-plugin/src/plugin.ts; packages/vendure-plugin/src/service/order-create.service.ts (setupState, stock allocation); docs/adr/0002-order-path-vendure-plugin.md §3 and Consequences 7. -->

8. **Sign in and make a sale.** Open `https://vendurepos.vercel.app` (the custom
   domain `https://app.vendurepos.com` will follow later). Enter the
   store URL (for example `https://store.example.com`; a trailing `/admin-api`
   is accepted), your administrator email and password. Enter the optional
   channel token to select a channel; leave it blank for the default channel.
   For scanning, enter the name of an existing single text `ProductVariant`
   custom field, such as `barcode`; leaving it blank disables this field choice.
   <!-- Sources: docs/PLAN.md §1; apps/pos/app/sign-in.tsx; apps/pos/lib/sign-in.ts; apps/pos/lib/store-url.ts; dev/vendure-store/src/vendure-config.ts. -->

   Wait for the catalogue and settings, enter the counted opening float and open
   the register. Search for or scan a product, add it to the cart, choose cash
   or record a payment already taken on your external card terminal, and complete
   the tender. For cash, enter the amount received. Check the receipt and change;
   print the receipt through the browser if needed. Once the order has synced,
   check Vendure for the POS prices, settled `tally-pos` payment, delivered
   fulfilment, stock reduction and `tallySaleAt`. To try offline sales, sync first,
   disconnect while the POS stays open, sell, then reconnect and let orders drain.
   <!-- Sources: apps/pos/app/index.tsx; apps/pos/e2e/offline.spec.ts; docs/PLAN.md §1; docs/adr/0002-order-path-vendure-plugin.md §3. -->

9. **Troubleshoot.**

   - **CORS / cannot reach the store:** check the exact POS origin in
     `CORS_ORIGINS`, the object-valued `apiOptions.cors`, and restart the server.
     Use HTTPS for a remote store. The hosted HTTPS build does **not** use the
     LAN `http:` rewrite: leave `VENDUREPOS_WEB_ALLOW_LAN_HTTP` unset. That option
     adds `http:` to `connect-src` and `img-src` only for exports served over
     plain HTTP on the same LAN; it cannot bypass HTTPS mixed-content blocking.
     <!-- Sources: docs/DISCOVERY.md §2.5; apps/pos/lib/store-url.ts; apps/pos/scripts/csp-lan-http.ts; apps/pos/public/index.html. -->
   - **401:** verify `'bearer'` in `tokenMethod`. For “Your session has ended.
     Sign out, then sign in again.” or “The store refused this sign-in. Sign out,
     then sign in again.”, do exactly that. Check the credentials and channel
     token if sign-in or settings reads still fail.
     <!-- Sources: apps/pos/lib/use-catalogue.ts; apps/pos/app/index.tsx (outboxNotice); apps/pos/lib/sign-in.ts; dev/vendure-store/src/vendure-config.ts. -->
   - **Missing / old plugin:** “This store's VendurePOS plugin is missing or out
     of date. Install or update it, then this till continues.” means the store
     must advertise `order.create` v4 and register v1. Install/update the plugin,
     apply its schema changes and restart Vendure; the till retries. For “The
     store's VendurePOS plugin isn't answering. Orders are kept and retried.”,
     check that `/tally/v1/info` and `/tally/v1/commands` reach the plugin through
     the store's proxy. Keep queued orders while fixing the store.
     <!-- Sources: apps/pos/app/index.tsx; apps/pos/lib/use-sale-settings.ts; packages/vendure-plugin/src/api/info.controller.ts; packages/vendure-plugin/src/plugin.ts. -->
