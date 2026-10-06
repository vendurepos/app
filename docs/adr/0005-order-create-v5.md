# order.create version 5 in the Vendure plugin: fees, shipping and custom lines

Status: Proposed
Date: 2026-10-06

## Context

TallyUI ADR-075 adds `order.create` version 5. The contract is in
`~/agent/handoff/tallyui-order-create-v5-2026-10-06.md`. Version 5 adds three things:
- `fees[]` and `shipping[]`: charges, each with `amountMinor`, `taxStatus` and an optional `taxClass`;
- `lines[].custom`: a line with no `variantId`.

The fee and shipping charges are instructions (ADR-070): the plugin must honour them or refuse them. TallyUI sends version 5 only for an order that carries one of the three. Plugin 0.3.0 accepts it beside versions 1–4 and advertises `5` in `/tally/v1/info`.

How the plugin builds an order today (`order-create.service.ts` `recipe()`), and the Vendure 3.7.3 limits that shape this ADR:
- **Product lines** are `addItemToOrder` calls, priced by `TallyPriceStrategy` from line custom fields.
- **Discounts** are negative `TALLY-DISCOUNT` Surcharges carrying their line's `taxLines`.
- **Rounding** is a `TALLY-ROUNDING` bridge Surcharge.
- **Shipping** is the `tally-in-store` method, at price 0.
- **Fulfilment** is one manual fulfilment over `order.lines`.
- **An OrderLine must have a ProductVariant:** `productVariantId` is NOT NULL. Vendure has no custom-line mechanism; its documented "extra item that is not a ProductVariant" is the **Surcharge**, which has no quantity and plays no part in stock or fulfilment.
- **An order with no OrderLines cannot reach `ArrangingPayment`** (`default-order-process`: "cannot transition to payment when order is empty").
- **One ShippingLine per order** in practice: the default `ShippingLineAssignmentStrategy` gives every order line to the last ShippingLine, and `applyShipping` drops the others. The shipping calculator sees only the order, not which line it prices.
- **`TaxCategory` has no `code`**, only `id`, `name` and `isDefault`. A category with no rate in the zone falls back to Vendure's zero `defaultTaxRate`.

## Decision (proposed)

1. **Fees become Surcharges.**
   - Each fee is a Surcharge with `sku: 'TALLY-FEE'`, `description: name`, `listPrice: amountMinor`, and `listPriceIncludesTax: payload.pricesIncludeTax`.
   - Its `taxLines` are `[]` for `taxStatus: 'none'`. Otherwise they come from the rate that `taxClass` resolves to in the order's tax zone (point 4).
   - Fees are never discounted, as the contract requires.
   - The v4 figures leave fees out of `subtotalMinor` and `discountMinor`.

2. **Shipping becomes the order's real ShippingLine,** so Vendure's own shipping totals and reports are right.
   - The `tally-in-store` calculator prices the line from an order custom field (`tallyShipping`: amount, inclusive flag and resolved tax rate), written before `setShippingMethod`. Without the field it charges 0, as today.
   - `name` and `methodId` are recorded on that custom field.
   - **More than one `shipping[]` entry is refused** with `invalid_payload`, naming `payload.shipping[1]`. The store can't keep two ShippingLines, and an instruction it can't honour is refused, never merged (ADR-070 Decision 3).
   - **Alternative:** shipping as `TALLY-SHIPPING` Surcharges takes any number of entries, but Vendure would show 0 shipping on the order.

3. **Custom lines become real OrderLines on a plugin-owned "POS custom item" variant.**
   - **The variant:**
     - created by `StoreSetupService` at bootstrap, as it creates the POS payment and shipping methods;
     - SKU `TALLY-CUSTOM-ITEM`;
     - `trackInventory: false`, the product disabled for the shop, assigned to every channel.
   - **Each line** is added with the existing `tallyUnitPrice` / `tallyClientLineId` custom fields, plus new readonly line custom fields `tallyCustomName` and `tallyCustomSku`.
   - **Tax:** the line's `taxCategory` is set to the category resolved from `taxStatus` / `taxClass` before pricing:
     - `taxStatus: 'none'` uses a plugin-owned "POS no tax" category with no rates, so Vendure's zero default rate applies;
     - otherwise the resolved category.
   - **Discounts:** custom lines take their discounts like any line, as a `TALLY-DISCOUNT` Surcharge with the line's `taxLines`.
   - **Fulfilment:** they are part of the in-store fulfilment.
   - **Why not Surcharges:**
     - an order of only custom lines (a repair, a service) would have no OrderLines and could not be paid;
     - a Surcharge has no quantity;
     - a Surcharge would fall outside fulfilment.

     WooCommerce POS solves the same problem with a misc product.
   - **The cost:** one disabled product and one tax category in the merchant's store. In the Dashboard, the line shows as "POS custom item", with the real name in its custom field. A Dashboard order-line display extension could later show `tallyCustomName` instead.

4. **`taxClass` resolves to a Vendure TaxCategory** by case-insensitive `name`, else by id.
   - Absent means the channel's default category (`isDefault`).
   - An unknown class is refused with `invalid_payload`, naming the field.
   - The rate is `TaxRateService.getApplicableTaxRate(ctx, activeZone, category)`, the same zone Vendure uses for the order's lines.

5. **Validation and the rest:**
   - **Strict shape:** `strict-shape.ts` gains `fees`/`shipping` at version 5, `FEE`/`SHIPPING` field tables, and `lines[].custom` at version 5.
   - **Payload shape:** `payload-shape.ts` requires `variantId` only on a non-custom line, and forbids it on a custom one.
   - **Lines still must not be empty.** A fees-only order is refused, because Vendure can't pay an order with no lines.
   - **`taxByRate`, `total_mismatch` and `figures_mismatch`** cover the new charges: `taxSummary` already includes surcharges and shipping lines, and the tolerance count gains the ShippingLine.
   - **Idempotency** needs no change: the fingerprint covers the whole payload.
   - **Golden pairs:** both pairs in the handoff (§3.1, §3.2) become plugin e2e tests, and so do §3.3's four refusals.

## Consequences

- **A new contract, door:one-way:** `/tally/v1/info` advertises `[1, 2, 3, 4, 5]`. A store on 0.3.0 accepts fees, one shipping charge and custom lines; plain sales are unchanged and still go as v1–v4.
- **The merchant's store gains** the "POS custom item" product and the "POS no tax" category at bootstrap. They are idempotent, and they need a migration for the two new line custom fields and the order custom field.
- **One shipping charge per order** is a Vendure limit. TallyUI's till could cap shipping at one entry per order for Vendure stores; that is a TallyUI follow-up if the refusal ever shows.
- **Split tender:** `payments[]` was already an array. The plugin applies several payments (`recipe.e2e.ts` proof 9), and the app's Split button relies on it.

**For the front desk to rule:**
- **(a)** custom lines on a plugin-owned variant (recommended) or as Surcharges;
- **(b)** shipping as the real ShippingLine with more than one refused (recommended), or as Surcharges;
- **(c)** `taxClass` matched by TaxCategory name.
