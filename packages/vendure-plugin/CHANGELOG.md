# Changelog

## Unreleased

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
