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

**Score:** **11 / 56** rows at parity (round 5, 2026-11-12). The two rows marked N/A are not counted.

---

## 1. Sell screen frame (every sale)

| WCPOS | VendurePOS |
|---|---|
| ![](demo-pairs/02-sell-empty-wcpos.webp) | ![](demo-pairs/02-sell-empty-vendurepos.webp) |

- [ ] **1.1 Navigation rail.** Wide screens show a left icon rail (POS, Products, Orders, Customers, Reports; Store health, Settings and Support at the foot; the version number), and phones get a drawer. Done (spec B1, TallyUI 3.18.0 `AppShell`): the rail on wide screens and the drawer on phones, with POS, Orders (badged with orders that need attention), Register and Settings. *Left:* Products, Customers, Reports, Store health and Support have no screens in VendurePOS yet, and the rail shows no version number.
- [x] **1.2 Compact header.** One slim bar reading "Store · Register", with a bell and the cashier's avatar. Done (spec B1): one `RegisterBar` row (the name, the register pill, the signed-in store, last synced and Sync now on wide screens, the Register door, the avatar); the avatar opens a cashier sheet with X report, Closures and Sign out; the demo banner is one slim row. A single-register store shows no register name, as in v2. No bell: VendurePOS has no notifications yet.
- [ ] **1.3 Product images on tiles.** *App/shared:* the Vendure connector needs `featuredAsset`, and the tile needs an image slot. VendurePOS tiles are text only.
- [x] **1.4 In-cart quantity badge on a tile.** *Shared:* the tile. Done (spec B2): the till passes its cart lines to TallyUI 3.18.0's `Catalogue`, whose grid tiles show the count.
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
- [x] **2.2 One "Checkout €total" button** opening the checkout screen (section 3). Done (spec B3): the cart foot has one "Checkout €total" button in place of Pay cash, Pay by card and Split.
- [ ] **2.3 Customer chip in the cart header** ("GU Guest", with an address pin). VendurePOS has an "Add customer" button. *App.*
- [x] **2.4 Line table with column heads** QTY / ITEM / PRICE / TOTAL. *Shared:* `CartPanel`. Done (spec B2): TallyUI 3.18.0's `CartColumnHeads` and `CartLine` in the till's own cart; the Price column folds on a narrow cart or a phone, as in v2. The price popover followed in spec B4 (2.7).
- [ ] **2.5 Line shows the variant's attributes** ("Size: 32 · Color: Blue") **and a struck-through regular price** on sale items. VendurePOS shows "name · variant" and no regular price. *App/connector.*
- [ ] **2.6 Tap the quantity for a keypad popover** (− / +, 0–9, Done). *Shared:* a keypad popover. Mostly done (spec B2): tapping a line's quantity opens TallyUI 3.18.0's `LinePopover` keypad (0–9, delete, Apply, Cancel), with the line's Discount and Remove as its actions (spec B4). *Left:* the keypad has no − / + keys.
- [x] **2.7 Tap the price for a keypad with quick discounts** (−5 / −10 / −15 %). Done (spec B4): when the till allows price edits, tapping a line's price opens TallyUI's `LinePopover` price keypad. It has v2's −5 / −10 / −15 % quick keys and strikes through the regular price when the line is sold below it. When the Price column folds (narrow cart or phone), Price is an action in the quantity keypad and opens the price form.
- [x] **2.8 Quiet lines.** WCPOS shows Edit / Remove on hover. Done (spec B4): the line shows only quantity, name, price and total. Discount and Remove are actions in the line's quantity keypad, one tap away, the touch-first equivalent of v2's hover (a till tablet has no hover).
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

  Mostly done (spec B3): Checkout opens TallyUI 3.19.0's `TenderPane` in the catalogue's place, with "Remaining €x", method tiles, quick amounts, a keypad and the Payments list; the cart stays on the right, locked, with its totals. On a phone the pane fills the Cart tab. *Left:* the Split chip, and Paid / Remaining sit in the pane rather than in the summary on the right.
- [ ] **3.2 Payment-method list on one screen:** Cash, Card, and the store's other methods. Mostly done (spec B3): Cash and Card terminal are tiles on the one checkout screen. *Left, Vendure way:* the tiles are the till's fixed pair, not the channel's own payment methods.
- [x] **3.3 Split payments shown as a Payments list** with Paid and Remaining. Done (spec B3): each leg is a ledger row (method, amount, Captured, Cancel payment) under "Remaining €x" and "€x of €y paid"; the next leg pre-fills the remaining balance.
- [x] **3.4 Quick cash amounts complete the sale.** Done (spec B3): tapping €50.00 and Take enables Complete sale and shows the change; e2e "a demo cashier pays cash with a quick amount" proves it.
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
| 2 | 2026-11-12 | 4 / 56 | B1 frame: 1.2. |
| 3 | 2026-11-12 | 6 / 56 | B2 cart: 1.4, 2.4. |
| 4 | 2026-11-12 | 9 / 56 | B3 checkout: 2.2, 3.3, 3.4; 3.1 and 3.2 mostly done. |
| 5 | 2026-11-12 | 11 / 56 | B4 cart lines: 2.7, 2.8. |
