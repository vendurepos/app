# Core POS features for Vendure: what the app has

This file lists the core POS features a Vendure merchant expects and says how far the VendurePOS app has each one, so that choosing the next item never needs a ruling. WCPOS v2 is the reference for which features a POS needs, and for taste. It is not a spec for how they work. Each row is built Vendure's own way: its roles and permissions, channels, channel prices, promotions and auth (Paul, 2026-10-07: "We're not trying to force Medusa to act like WooCommerce. We're playing to the strengths of each different platform."). Where WCPOS's mechanism is WooCommerce's own, the row names Vendure's equivalent, or says N/A when Vendure has none and a merchant would not miss it. The lane takes the first open row of **Default order** (at the end) unless the front desk says otherwise. Update this file in the PR that changes a row.

Read on 2026-10-06:
- **The app:** `main` at `650ad9f`, `@tallyui/*` 3.8.0, plugin 0.3.0 with register v2 in vendurepos/app#167.
- **WCPOS:** the WCPOS wiki (`~/Projects/wiki`), i.e. the shipped 1.10 line plus the merged but unreleased 2.0 features.

Quoted test names are Playwright tests in `apps/pos/e2e/demo.spec.ts` unless a row names another file.

**Key**
- **WCPOS tier:** where WCPOS has the feature: Free, Pro, or 2.0 (merged, not yet released). It says the feature exists, not how Vendure must do it.
- **Status:** Has, Partial, Missing, or N/A (no Vendure meaning).
- **Owner:** where the missing part belongs.
  - **TallyUI:** platform-neutral; a TV job there, then a version bump here.
  - **app:** `apps/pos`.
  - **plugin:** `packages/vendure-plugin`.

**Wiki sources** (paths under `~/Projects/wiki/`)
- `FS` `product/features/free-selling.md`
- `FR` `product/features/free-receipts-and-printing.md`
- `PRO` `product/features/pro-and-add-ons.md`
- `CMP` `product/features/comparison-and-pricing.md`
- `RS` `architecture/client/register-screen.md`
- `MS` `architecture/client/management-screens.md`
- `RG` `architecture/client/register-sessions.md`
- `PC` `architecture/client/payments-contract.md`
- `RC` `architecture/client/reports-and-closures.md`
- `CR` `architecture/client/checkout-refunds.md`
- `BS` `support/products/barcode-scanning.md`
- `INT` `support/international.md`
- `PERM` `support/permissions.md`

## Selling and cart

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Cart: quantity, remove a line, edit a line's price | Free (FS, RS) | Has | `apps/pos/lib/sale-cart.tsx`; the price-edit setting is in `apps/pos/app/settings.tsx` | — |
| Line and order discounts | Free (FS) | Has | TallyUI `DiscountForm`/`DiscountChips`; `apps/pos/e2e/sign-in.spec.ts` "a discounted sale" | — |
| Fees, shipping, custom lines | Free (FS) | Has | `order.create` v5 (`docs/adr/0005-order-create-v5.md`); one shipping line per order (`shipping_single`) | — |
| Park and resume a sale | Free (RS) | Has | TallyUI `ParkedSales`; e2e "parks a sale" | — |
| Several open orders as tabs; order note | Free (RS) | Missing | Parking only; no tabs and no note | TallyUI |
| Wide (two columns) and phone (tabs) layouts | Free (RS) | Has | `apps/pos/app/index.tsx` `WIDE_MIN_WIDTH` | — |
| Prevent overselling | Free (FS) | Partial | The till never refuses a sale. The store tops stock up and applies it with an `insufficient_stock` warning (`order-create.service.ts`, `test/stock.e2e.ts`); nothing warns the cashier before checkout | TallyUI, then app |

## Products and search

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Grid/table toggle, category navigation, search | Free (FS, RS) | Has | TallyUI `Catalogue`; e2e "switches the products to a table" | — |
| Variations: one tile, then pick the variant | Free (RS) | Partial | Each variant is its own item. TallyUI ships `VariantPicker`, but neither `Catalogue` nor the app uses it | TallyUI, then app |
| Browse by facet (Vendure's tags and brands); filter chips | Free (RS) | Missing | Categories are Vendure collections (`getCategories`). The connector syncs each variant's `facetValues`, but nothing browses or filters by them | TallyUI |
| Stock and price editing at the till | Pro (PRO) | Missing | In Vendure's terms: stock per stock location, and the price in the signed-in channel. `stock.adjust` is in PLAN's "M6 proper". A cost price is not a Vendure core field | TallyUI + plugin |
| Per-store pricing | Pro (PRO) | Has | A store is a Vendure channel, and a variant's price is per channel in Vendure core. The till reads the signed-in channel's price, and the plugin records the as-sold price with no overrides: `packages/vendure-plugin/test/store-pricing.e2e.ts`. A sale price in one store is a Vendure promotion in that channel (the promotions row) | — |

## Customers

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Search and attach a customer; guest sales | Free (FS) | Has | `apps/pos/lib/sale-customer.tsx`; e2e "attaches a customer" | — |
| Create a customer from the cart | Pro (MS) | Has | The connector's `createCustomer` (online only); `apps/pos/e2e/sign-in.spec.ts` "a sale to a searched customer, and one to a new customer, land on those customers in Vendure" | — |
| Customers management screen | Pro (MS) | Missing | No route | TallyUI, then app |

## Checkout and payments

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Cash with quick amounts and change | Free (FS, PC) | Has | `apps/pos/lib/sale-tender.tsx` | — |
| Card recorded as an external payment | Free (PC) | Has | "Card payment approved" | — |
| Split payment | 2.0 (CMP) | Has | TallyUI `SplitTender`; e2e "splits a sale" | — |
| Offline checkout | 2.0 (CMP) | Has | VA5/VA7; `apps/pos/e2e/offline.spec.ts` | — |
| Gateways and terminals (Stripe, SumUp, Mollie), Tap to Pay | Pro (PRO, PC) | Missing | Only the plugin's `tally-pos` handler | TallyUI + plugin |
| Tips; a payment that is authorized before it settles | Free (FS, PC) | Missing | Every sale settles as PaymentSettled. WCPOS sets a WooCommerce order status per gateway; in Vendure the payment method's handler decides each payment's state | TallyUI + plugin |
| Customer-facing display | Pro (CMP) | Missing | — | TallyUI |

## Receipts and printing

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| On-screen receipt; browser print | Free (FR) | Has | `apps/pos/lib/sale-receipt.tsx`; `apps/pos/e2e/sign-in.spec.ts` "Print receipt prints the receipt alone" | — |
| Email receipt (with an offline queue) | Free (FR) | Missing | The plugin's confirmation email is off for POS orders (`tallyOrderConfirmationHandler`) | TallyUI + plugin |
| Receipt templates, gallery, fiscal mode | Free (FR) | Missing | One fixed layout (`buildReceiptData`) | TallyUI |
| Thermal ESC/POS, cloud printing, routing between printers | Free (FR) | Missing | Cut from the MVP (PLAN §1) | TallyUI |

## Orders and refunds

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Order history | Pro (MS) | Partial | `OrdersList` shows only this till's outbox (VA5), not the store's orders | TallyUI + app |
| Refunds | Pro (CR, PRO) | Missing | No refund command; refunds stay out of every register figure (ADR 0003). The store side is Vendure's own refund (`refundOrder`). The plugin declares `TallyPosRefund`, which the command will check (Front desk, 2026-10-07: online only, POS orders only in v1, refused with no open session). TallyUI's `order.refund` v1 contract comes first | TallyUI contract, then plugin |
| Promotions and coupon codes | 2.0 (CMP, PRO) | Missing | Vendure promotions, with or without a coupon code, are off on POS orders (ADR 0002) | TallyUI contract, then plugin |

## Registers, cash and reports

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Open with float, cash in/out, count, close, Z report | 2.0 (RG, CMP) | Has | Register commands v1 (ADR 0003); `apps/pos/e2e/sign-in.spec.ts` "a register day" | — |
| Resume after a lost till; take-over by another till | 2.0 (RG) | Has | vendurepos/app#167 (ADR 0006) and `@tallyui/*` 3.8.0 (vendurepos/app#175); `apps/pos/e2e/sign-in.spec.ts` "a till that lost its local state resumes its own open session" and "another till takes the register over; …" | — |
| Approval of an over-variance close | 2.0 (RG) | Partial | The approver is typed and recorded, but the server does not check it (ADR 0003 "Not built: c2c"). The design is medusapos ADR 0023: an approval route that checks the manager's credential and `ApproveTallyPosVariance`, and a single-use proof on `register.closure.submit` at register contract 3. It waits on TallyUI's contract 3 | TallyUI contract + plugin |
| Reports: sales, closure history | Free/Pro, still moving (RC) | Missing | Only the Z print (`apps/pos/lib/z-report.ts`); no `GET /tally/v1/registers/{id}` | plugin + TallyUI |

## Offline and sync

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Offline catalogue, queued orders, exactly-once | Free (FS) | Has | `apps/pos/lib/catalogue.ts`; the plugin's command ledger | — |
| Sync status; "Send again" on a refused batch | Free (FS) | Has | `SyncStatus`, `outboxNotice` | — |
| Deletions reach the till | Free (FS) | Missing | PLAN "M6 proper" (TSP pull) | TallyUI + plugin |
| Store health, log viewer | Free (FS) | Missing | Logging only (`apps/pos/lib/logging.ts`) | TallyUI |

## Users, sign-in and settings

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Connect and sign in | Free (FS) | Has | `apps/pos/app/sign-in.tsx`, password or till key (ADR 0004) | — |
| Sign in again after a 401; session list | Free (FS) | Partial | `apps/pos/lib/sign-in-again.tsx`; no session list | TallyUI |
| Roles and permissions | Free (PERM) | Partial | Three Vendure custom permissions, assigned to Vendure roles (medusapos ADR 0023, "What vendurepos can copy"). `TallyPosSell` (or `CreateOrder`) gates every `/tally/v1` route, and a 403 is refused at sign-in; a later 403, on a pull or on a command, asks the till to sign in again with the same words (`apps/pos/e2e/sign-in.spec.ts`). `ApproveTallyPosVariance` marks a manager and `TallyPosRefund` a till that may refund; neither opens those routes: `packages/vendure-plugin/test/permissions.e2e.ts`. The till role preset is `tallyEnsurePosTillRole`. Missing: nothing checks `ApproveTallyPosVariance` until the approval route (`POST /tally/v1/register-approvals`, the approval row) lands, nor `TallyPosRefund` until the refund command (the Refunds row) does | TallyUI contract + plugin |
| Switching cashiers | — (WCPOS lacks it too) | Missing | M7 | TallyUI |
| Settings screen | Free (FS, MS) | Partial | Setting by setting in **Settings, one by one** below; what is left there belongs to TallyUI or to other rows | TallyUI |

## Settings, one by one

The settings a Vendure merchant expects on a till, checked against `apps/pos/app/settings.tsx`. WCPOS v2's Settings groups (`architecture/client/navigation-and-settings.md`, `architecture/client/store-settings.md`) are the checklist. Where Vendure keeps a setting on the channel, the till reads it from there and has no local copy. A setting that needs the plugin gets its own row in the tables above; none does today beyond the rows already named.

| Setting | WCPOS group (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Store name | General (store-settings) | Has | Read from the Vendure channel at sign-in and shown in the header (`apps/pos/lib/store-label.ts`). Vendure owns it, so there is no local override | — |
| Store address, outlet | General (store-settings) | N/A | A Vendure channel has no address; several stores is the "Multi-store" row | — |
| Register | General (RG) | Has | Bound at the first open; "Choose another register" rebinds it (ADR 0006) | — |
| Language, locale | General (INT) | Missing | The "Translations, RTL, store locale" row | TallyUI |
| Currency | General (store-settings) | Has | The channel's currency, read at sign-in; Vendure owns it | — |
| Money formatted for the store (symbol position, separators) | General (store-settings) | Missing | WooCommerce stores the format as settings; Vendure has none, so the format follows the channel's language and currency through `Intl`. TallyUI's `formatMoney` takes only a locale and its components pass none; decimals follow ISO 4217 (`minorUnitDigits`) | TallyUI |
| Default customer for new sales | General (`default_customer`) | Has | Settings › Customers; `apps/pos/e2e/demo.spec.ts` "a default customer starts each new sale and can be removed from one" | — |
| Cashier as the default customer | General (`default_customer_is_cashier`) | N/A | A Vendure administrator is not a customer | — |
| Order status per gateway | Checkout (FS) | N/A | WooCommerce order statuses. In Vendure the payment method's handler decides the payment's state, so there is no till setting (the "Tips; a payment that is authorized before it settles" row) | — |
| Customer required | — | N/A | WCPOS has no such setting (FS "Guest orders") | — |
| Prevent overselling | Checkout (FS) | Partial | Its own row under Selling and cart | TallyUI, then app |
| Print the receipt after each sale | Printing (printer profile auto-print) | Has | Settings › Printing, web only (native has no print path); `apps/pos/e2e/demo.spec.ts` "with printing after each sale on, the receipt prints once by itself" | — |
| Prices entered with tax | Tax: Calculation (store-settings) | Has | The channel's `pricesIncludeTax`, read at sign-in | — |
| Prices shown with or without tax | Tax: Display (store-settings) | N/A | WooCommerce's separate display flags. Vendure's answer is the channel's `pricesIncludeTax` (the row above), and TallyUI's catalogue and cart show prices that way | — |
| Tax rates | Tax: Tax Rates | Partial | The cart and receipt show tax per rate (`TaxRows`); no screen lists the rates | TallyUI |
| Receipt template | Printing (FR) | Missing | The "Receipt templates, gallery, fiscal mode" row | TallyUI |
| Printers | Printing (FR) | Missing | The "Thermal ESC/POS, cloud printing" row | TallyUI |
| Shortest barcode | Barcode scanning (BS) | Has | Settings › Scanner | — |
| Barcode field | Barcode scanning (BS) | Has | Set when signing in, shown in Settings | — |
| Scan sounds | Barcode scanning (BS) | Missing | The "Camera scan; scan sounds" row | TallyUI |
| Line price editing | Cart display (FS) | Has | Settings › Prices | — |
| Quick discount buttons | Cart display (FS) | Missing | TallyUI's `DiscountForm` has no preset percentages | TallyUI |
| Grid tile size and tile fields | Products display (FS) | Missing | TallyUI's `Catalogue` takes no column count or field list | TallyUI |
| Theme | Theme | Missing | `@tallyui/theme` ships one light scheme | TallyUI |
| Count difference needing approval | — (VendurePOS, RG approval) | Has | Settings › Register | — |

## Barcode, tax, stores, language

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Keyboard-wedge scan, minimum length, barcode field | Free (BS) | Has | `apps/pos/lib/use-wedge-scanner.ts`, `docs/scan-policy.md` | — |
| Camera scan; scan sounds | Free (BS) | Missing | — | TallyUI |
| Store tax settings; tax per rate | Free (FS) | Has | TallyUI `TaxProvider`, `TaxRows` | — |
| Multi-store | Pro (PRO) | Missing | A Vendure store is a channel, and each channel has its own prices (the per-store pricing row). A till signs in to one channel; moving to another means signing in again | TallyUI + plugin |
| Translations, RTL, store locale | Free (INT) | Missing | English only | TallyUI |
| Extension directory, add-ons, Pro upsell | Free/Pro (FS, PRO) | N/A | — | — |

## Default order

The next item is the first row here that is not done. Rows marked TallyUI start as a note to the front desk, which dispatches the TV job; this repo then takes the bump.

1. Register v2 store side: vendurepos/app#167 (merged). Done.
2. The till side of register v2: bump `@tallyui/*` to the release that carries TallyUI#469 and the outbox (#472); prove resume and take-over in an e2e. Done.
3. Order history from the store, not just the outbox. It comes before refunds, which start from an order.
4. Refunds: a TallyUI contract, then a plugin command, with refunds counted in the register figures.
5. Email receipt: Vendure's email plugin already sends mail, so this is mostly plugin work behind a TallyUI action.
6. Reports and closure history: `GET /tally/v1/registers/{id}` in the plugin.
7. The variant picker in the catalogue (TallyUI's `VariantPicker` exists).
8. Camera scan.
9. Promotions and coupon codes (Vendure promotions on POS orders: a contract question first).
10. Everything else, in table order.
