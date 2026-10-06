# WCPOS v2 parity: what the Vendure app has

This file lists the features of WCPOS v2 and says how far the VendurePOS app has each one, so that choosing the next item never needs a ruling. The lane takes the first open row of **Default order** (at the end) unless the front desk says otherwise. Update this file in the PR that changes a row.

Read on 2026-10-06:
- **The app:** `main` at `76ca317`, `@tallyui/*` 3.5.1 (3.5.3 in vendurepos/app#168), plugin 0.3.0 with register v2 in vendurepos/app#167.
- **WCPOS:** the WCPOS wiki (`~/Projects/wiki`), i.e. the shipped 1.10 line plus the merged but unreleased 2.0 features.

Quoted test names are Playwright tests in `apps/pos/e2e/demo.spec.ts` unless a row names another file.

**Key**
- **WCPOS tier:** Free, Pro, or 2.0 (merged, not yet released).
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
| Browse by tag or brand; filter chips | Free (RS) | Missing | — | TallyUI |
| Stock, price and cost editing | Pro (PRO) | Missing | `stock.adjust` is in PLAN's "M6 proper" | TallyUI + plugin |
| Per-store pricing | Pro (PRO) | Missing | Vendure channels would carry it | plugin |

## Customers

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Search and attach a customer; guest sales | Free (FS) | Has | `apps/pos/lib/sale-customer.tsx`; e2e "attaches a customer" | — |
| Create a customer from the cart | Pro (MS) | Partial | The connector implements `createCustomer` (online only); no e2e proves the path | app (an e2e) |
| Customers management screen | Pro (MS) | Missing | No route | TallyUI, then app |

## Checkout and payments

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Cash with quick amounts and change | Free (FS, PC) | Has | `apps/pos/lib/sale-tender.tsx` | — |
| Card recorded as an external payment | Free (PC) | Has | "Card payment approved" | — |
| Split payment | 2.0 (CMP) | Has | TallyUI `SplitTender`; e2e "splits a sale" | — |
| Offline checkout | 2.0 (CMP) | Has | VA5/VA7; `apps/pos/e2e/offline.spec.ts` | — |
| Gateways and terminals (Stripe, SumUp, Mollie), Tap to Pay | Pro (PRO, PC) | Missing | Only the plugin's `tally-pos` handler | TallyUI + plugin |
| Tips; order status per gateway | Free (FS, PC) | Missing | Every sale settles as PaymentSettled | TallyUI + plugin |
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
| Refunds | Pro (CR, PRO) | Missing | No refund command; refunds stay out of every register figure (ADR 0003) | TallyUI contract, then plugin |
| Coupons | 2.0 (CMP, PRO) | Missing | Vendure promotions are off on POS orders (ADR 0002) | TallyUI contract, then plugin |

## Registers, cash and reports

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Open with float, cash in/out, count, close, Z report | 2.0 (RG, CMP) | Has | Register commands v1 (ADR 0003); `apps/pos/e2e/sign-in.spec.ts` "a register day" | — |
| Resume after a lost till; take-over by another till | 2.0 (RG) | Partial | Store side in vendurepos/app#167 (ADR 0006); the till side comes with the next `@tallyui/*` release | app (a bump) |
| Approval of an over-variance close | 2.0 (RG) | Partial | The approver is typed and recorded, but the server does not check it (ADR 0003 "Not built: c2c") | TallyUI contract + plugin |
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
| Roles and capabilities | Free (PERM) | Partial | One permission, `TallyPosSell` | plugin |
| Switching cashiers | — (WCPOS lacks it too) | Missing | M7 | TallyUI |
| Settings screen | Free (FS) | Partial | Three settings: shortest barcode, variance limit, price editing | app |

## Barcode, tax, stores, language

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Keyboard-wedge scan, minimum length, barcode field | Free (BS) | Has | `apps/pos/lib/use-wedge-scanner.ts`, `docs/scan-policy.md` | — |
| Camera scan; scan sounds | Free (BS) | Missing | — | TallyUI |
| Store tax settings; tax per rate | Free (FS) | Has | TallyUI `TaxProvider`, `TaxRows` | — |
| Multi-store | Pro (PRO) | Missing | One channel per sign-in | TallyUI + plugin |
| Translations, RTL, store locale | Free (INT) | Missing | English only | TallyUI |
| Extension directory, add-ons, Pro upsell | Free/Pro (FS, PRO) | N/A | — | — |

## Default order

The next item is the first row here that is not done. Rows marked TallyUI start as a note to the front desk, which dispatches the TV job; this repo then takes the bump.

1. Register v2 store side: vendurepos/app#167 (in review).
2. The till side of register v2: bump `@tallyui/*` to the release that carries TallyUI#469 and the outbox (#472); prove resume and take-over in an e2e.
3. Order history from the store, not just the outbox. It comes before refunds, which start from an order.
4. Refunds: a TallyUI contract, then a plugin command, with refunds counted in the register figures.
5. Email receipt: Vendure's email plugin already sends mail, so this is mostly plugin work behind a TallyUI action.
6. Reports and closure history: `GET /tally/v1/registers/{id}` in the plugin.
7. The variant picker in the catalogue (TallyUI's `VariantPicker` exists).
8. Camera scan.
9. Coupons (Vendure promotions on POS orders: a contract question first).
10. Everything else, in table order.
