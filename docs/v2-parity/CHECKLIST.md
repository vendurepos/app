# VendurePOS against demo.wcpos.com/pos: look-and-function checklist

**Finish line** (Paul, 10 Nov 2026, via the front desk): VendurePOS looks and functions like https://demo.wcpos.com/pos.

This file is the screen-by-screen, flow-by-flow list behind that goal. `AUDIT.md`, next to it, is the code-level audit against WCPOS 2.0.0's source. This list compares the two **running demos** as a cashier sees them.

## How to read this

**Sources**
- Captured 2026-11-10 at 1280×800:
  - WCPOS demo 2.0.0, signed in as demo/demo, store "US Store", register "Front Counter";
  - demo.vendurepos.com, built from `main` at 13:27 UTC.
- The WCPOS demo was only looked at. Nothing was saved, paid or synced, and every order push was blocked before it left the browser.
- The screenshots are in `demo-pairs/`, named `<nn>-<screen>-<wcpos|vendurepos>.webp`. A missing VendurePOS shot means the screen does not exist there.

**Order:** sections and rows follow what a cashier notices first. Section 1 is on screen for every sale; the last section is rarely opened.

**Row tags**
- **Owner** says where the work lives:
  - **app** is `apps/pos`;
  - **plugin** is `packages/vendure-plugin`;
  - **shared** is a TallyUI package, owned by the TallyUI worker and requested through the front desk.
- **Vendure way:** where WCPOS's mechanism is WooCommerce's own, the row asks for the Vendure equivalent (Paul, 2026-10-07). For example, facets stand in for tags and brands, and promotions for coupons.
- `[x]` means a cashier would call it the same. Partly-there rows stay `[ ]`, with the gap named.

**Score:** **3 / 56** rows at parity (round 1, 2026-11-10). The two rows marked N/A are not counted.

---

## 1. Sell screen frame (every sale)

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/02-sell-empty-wcpos.webp) | ![](demo-pairs/02-sell-empty-vendurepos.webp) |

- [ ] **1.1 Navigation rail.** Wide screens show a left icon rail (POS, Products, Orders, Customers, Reports; Store health, Settings and Support at the foot; the version number), and phones get a drawer. Done (spec B1, TallyUI 3.18.0 `AppShell`): the rail on wide screens and the drawer on phones, with POS, Orders (badged with orders that need attention), Register and Settings. *Left:* Products, Customers, Reports, Store health and Support have no screens in VendurePOS yet, and the rail shows no version number.
- [x] **1.2 Compact header.** One slim bar reading "Store · Register", with a bell and the cashier's avatar. Done (spec B1): one `RegisterBar` row (the name, the register pill, the signed-in store, last synced and Sync now on wide screens, the Register door, the avatar); the avatar opens a cashier sheet with X report, Closures and Sign out; the demo banner is one slim row. A single-register store shows no register name, as in v2. No bell: VendurePOS has no notifications yet.
- [ ] **1.3 Product images on tiles.** *App/shared:* the Vendure connector needs `featuredAsset`, and the tile needs an image slot. VendurePOS tiles are text only.
- [ ] **1.4 In-cart quantity badge on a tile.** *Shared:* the tile.
- [ ] **1.5 Browse by category.** Coloured category poster tiles with counts, a breadcrumb ("Categories › All products"), then the products. VendurePOS shows every product, with category chips. *App, Vendure way:* collections.
- [ ] **1.6 Filter pills.** In stock, On sale, Featured, Tag and Brand, with a searchable picker per pill. *Vendure way:* in stock, on sale, plus one pill per facet. *Shared:* `FilterChipGroup` exists in 3.12.0, so the work is the *app* wiring and the facet reads.
- [ ] **1.7 Camera scan button next to search.** Search itself is at parity. *App.*
- [ ] **1.8 "Showing n of N" and infinite load at the foot of the grid.** *App.*
- [ ] **1.9 Grid and table toggle.** Both demos have one, but the columns have not been compared. *App.*

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/02b-sell-all-products-wcpos.webp) | ![](demo-pairs/02c-sell-search-vendurepos.webp) |

## 2. Cart (every sale)

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/04-cart-3-items-wcpos.webp) | ![](demo-pairs/04-cart-3-items-vendurepos.webp) |

- [ ] **2.1 Open carts as tabs.** Every cart stays open by itself, and a strip under the cart shows "Guest $83.03 …", a count and "+ New"; one tap switches. VendurePOS has one sale and an explicit Park dialog. *Shared:* a cart-tabs strip (`ParkedSales` is the closest piece). *App:* several live carts.
- [ ] **2.2 One "Checkout €total" button** opening the checkout screen (section 3). VendurePOS has three buttons: Pay cash, Pay by card and Split. *App.*
- [ ] **2.3 Customer chip in the cart header** ("GU Guest", with an address pin). VendurePOS has an "Add customer" button. *App.*
- [ ] **2.4 Line table with column heads** QTY / ITEM / PRICE / TOTAL. *Shared:* `CartPanel`.
- [ ] **2.5 Line shows the variant's attributes** ("Size: 32 · Color: Blue") **and a struck-through regular price** on sale items. VendurePOS shows "name · variant" and no regular price. *App/connector.*
- [ ] **2.6 Tap the quantity for a keypad popover** (− / +, 0–9, Done). VendurePOS has steppers on every line. *Shared:* a keypad popover.
- [ ] **2.7 Tap the price for a keypad with quick discounts** (−5 / −10 / −15 %). VendurePOS has a price dialog and a separate discount dialog per line. *App.*
- [ ] **2.8 Quiet lines.** WCPOS shows Edit / Remove on hover. VendurePOS shows Discount and Price buttons and a stepper on every line. *App.*
- [x] **2.9 Itemised tax lines in the totals.** VendurePOS shows "incl. Reduced DE 7 %" and "incl. Standard DE 19 %", Vendure's way.
- [ ] **2.10 "+" menu:** misc product, fee, shipping, discount, new customer. VendurePOS's "Add charge" covers fee, shipping and custom item. Missing: a percentage fee and an "amount includes tax" switch. *App.*
- [ ] **2.11 Order details dialog:** customer note, tax exempt, void. VendurePOS has only an order discount. *App + plugin* (order note and void).
- [ ] **2.12 Toast when an item is added.** *App.*

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/04j-cart-open-orders-wcpos.webp) | ![](demo-pairs/04j-cart-open-orders-vendurepos.webp) |
| ![](demo-pairs/04d-cart-price-keypad-wcpos.webp) | ![](demo-pairs/04d-cart-price-keypad-vendurepos.webp) |
| ![](demo-pairs/04i-cart-order-details-wcpos.webp) | ![](demo-pairs/04i-cart-order-details-vendurepos.webp) |

## 3. Checkout and tender (every sale)

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/05-checkout-wcpos.webp) | ![](demo-pairs/05-checkout-vendurepos.webp) |

- [ ] **3.1 Full-screen checkout.** Its parts:
  - "TO PAY €x" with a Split chip;
  - payment-method cards;
  - quick amounts and a numeric keypad;
  - the order summary on the right, with a Payments list and Total / Paid / Remaining.

  VendurePOS has an in-column cash form. *Shared:* `CheckoutLayout` exists in 3.12.0; the keypad and method cards are needed. *App:* the screen.
- [ ] **3.2 Payment-method list on one screen:** Cash, Card, and the store's other methods. In VendurePOS, card and split are separate buttons back on the cart. *App, Vendure way:* the channel's payment methods.
- [ ] **3.3 Split payments shown as a Payments list** with Paid and Remaining. VendurePOS has a Split flow; *app* layout.
- [ ] **3.4 Quick cash amounts complete the sale.** On VendurePOS, tapping €50.00 did not enable Complete sale in headless Chromium; typing the amount did. *App:* verify, and fix if real.
- [x] **3.5 Receipt after the sale** with Print and New sale.

| WCPOS | VendurePOS |
|---|---|
| — | ![](demo-pairs/05b-checkout-tendered-vendurepos.webp) |
| — | ![](demo-pairs/12-receipt-vendurepos.webp) |

## 4. Variants

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/03-variations-wcpos.webp) | ![](demo-pairs/03-variations-vendurepos.webp) |

- [ ] **4.1 Variants open in place in the grid** as tiles with attribute chips ("32 Blue") and a Back tile. VendurePOS swaps the cart column for a variant list. *App:* the grid. *Vendure way:* option groups as the chips.

## 5. Customer on the order

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/06-customer-pick-wcpos.webp) | ![](demo-pairs/06-customer-pick-vendurepos.webp) |

- [ ] **5.1 Customer picker** with avatars and a Guest row. VendurePOS's search, list and "New customer" are close. *App.*
- [ ] **5.2 Per-order address editor:** billing, "shipping same as billing", company, tax ID. *App + plugin.*

## 6. Register and cashier

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/09b-register-panel-wcpos.webp) | ![](demo-pairs/09b-register-panel-vendurepos.webp) |
| ![](demo-pairs/09-register-user-sheet-wcpos.webp) | — |

- [ ] **6.1 Avatar sheet.** Its parts:
  - cashier, store, register and "since";
  - "Your sales today" and "In the drawer";
  - Pay in, Pay out and Close register;
  - hand the till to another account;
  - Sign out.

  VendurePOS has top-bar buttons. *App;* store and register switching need *plugin* support.
- [ ] **6.2 Register panel header:** the drawer total, "open since 03:12 · 11 h 34 m", other tenders, and Print X-report in the panel. VendurePOS has the same functions without that header, and X report sits in the top bar. *App.*
- [ ] **6.3 Pay in / pay out reason chips** (Float, Change, Bank, Other). VendurePOS has a free-text reason. *App.*
- [ ] **6.4 Close register: a cashier never sees a raw error.** Closing during a tender shows "RegisterTenderInProgressError: Finish or cancel…". *App:* a bug.
- [x] **6.5 Count the drawer by denomination at close.**
- [ ] **6.6 Several registers per store, picked on the device** ("Which register is this device at?"). *Plugin + app.*

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/09c-register-paid-in-wcpos.webp) | ![](demo-pairs/09c-register-paid-in-vendurepos.webp) |
| — | ![](demo-pairs/09d-register-close-vendurepos.webp) |

## 7. Orders

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/07-orders-wcpos.webp) | ![](demo-pairs/07-orders-vendurepos.webp) |
| ![](demo-pairs/07c-order-detail-wcpos.webp) | ![](demo-pairs/07c-order-detail-vendurepos.webp) |

- [ ] **7.1 Orders as a full screen from the rail.** It has a table (status, number, customer, date, cashier, payment method, total), is grouped by day, and has paging. VendurePOS has a "Recent" list of cards. *App.*
- [ ] **7.2 Order search and filters:** status, payment method, customer, cashier, register, date range. *App.*
- [ ] **7.3 Order detail:** items, totals, payment, Receipt reprint. The order sheet (#214) is on `main`, but in this capture a tap on a seeded demo order showed nothing. *App:* verify on the demo.
- [ ] **7.4 Refund from the order detail.** #216 is waiting on merge. *App.*

## 8. Reports

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/10-reports-wcpos.webp) | — |
| ![](demo-pairs/10b-reports-closures-wcpos.webp) | — |

- [ ] **8.1 Reports screen.** It has:
  - a drawer card;
  - today's KPIs (sales, orders, average, largest, items, discounts, vs yesterday);
  - a by-hour chart, the payment-method split and top products.

  The plugin's sales report endpoint is on `main` (#213). *App:* the screen.
- [ ] **8.2 Closures history** with cash at open and close, the discrepancy, and a CSV export. *App + plugin.*

## 9. Settings and look

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/11-settings-general-wcpos.webp) | ![](demo-pairs/11-settings-general-vendurepos.webp) |
| ![](demo-pairs/11-settings-theme-wcpos.webp) | ![](demo-pairs/11-settings-full-vendurepos.webp) |

- [ ] **9.1 Tabbed settings area.** The tabs are General, Tax, Printing, Card readers, Customer display, Barcode and Theme. VendurePOS has one long page. *Shared:* `SettingsLayout` exists in 3.12.0. *App:* adopt it.
- [ ] **9.2 Theme: System / Light / Dark, plus Scale.** VendurePOS follows the system light or dark mode (#210), with no picker and no scale. *Shared* theme tokens, *app* settings.
- [ ] **9.3 Language.** *Shared:* i18n.
- [ ] **9.4 Barcode settings with a test area.** VendurePOS has the length, prefix, suffix and sounds, but no test area. *App.*
- [ ] **9.5 Printing: printers and receipt templates.** VendurePOS has "Print after each sale". *Shared + app.*
- [ ] **9.6 Tax display options and "Tax based on: shop base / customer".** *App,* Vendure way: the zone.
- [ ] **9.7 Card readers.** *Shared + plugin,* Vendure way.
- [ ] **9.8 Customer display pairing.** *Shared + plugin.*
- [ ] **9.9 Product-grid settings sheet:** tile fields, browse by, sort, show out-of-stock. VendurePOS has products per row. *App.*
- [ ] **9.10 Cart settings:** panel side, open-orders position, columns, quick-discount presets, auto-show and auto-print receipt. *App.*

## 10. Back office

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/06c-customers-wcpos.webp) | — |
| ![](demo-pairs/08-products-wcpos.webp) | — |
| ![](demo-pairs/13d-store-health-wcpos.webp) | — |

- [ ] **10.1 Customers screen:** list, search, edit. *App.*
- [ ] **10.2 Products screen:** stock and price edited inline, with a manage-stock switch. *Plugin + app.*
- [ ] **10.3 Store health:** "Ready to sell", changes waiting to send, records that need attention (Fix / Retry), per-collection coverage. VendurePOS has Settings › Sync log and "Last synced / Sync now". *App.*
- N/A **10.4 Coupons screen.** Vendure promotions are managed in the Vendure admin (`AUDIT.md` §19). A coupon-code field in the cart is a separate row once one is found in WCPOS's cart.

## 11. Rarely seen

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/13-notifications-wcpos.webp) | — |

- [ ] **11.1 Notifications bell and inbox.** *App.*
- [ ] **11.2 Support entry in the rail.** *App:* for VendurePOS, docs and GitHub links in place of a chat widget.
- N/A **11.3 Sign-in page.** WCPOS uses the store's WordPress login; VendurePOS has its own sign-in and a demo landing page. Neither is a POS screen to match.

---

## Rounds

| Round | Date | Score | Moved |
|---|---|---|---|
| 1 | 2026-11-10 | 3 / 56 | Baseline. |
