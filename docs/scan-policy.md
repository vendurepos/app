# What a barcode scan does

The rule (Front desk, 2026-09-30): **a scan is intent to sell and is never silent.**

- It adds visibly wherever a sale can be edited, closing panels or sheets to do so.
- It starts a sale where none is open.
- It shows a notice where adding is impossible (payment taken, register counting or closing).

A keyboard-wedge scan is caught by `useWedgeScanner` (`apps/pos/lib/use-wedge-scanner.ts`) wherever the focus is,
except in a non-money text field, and handled by the `useWedgeScanner` callback in `Sale` (`apps/pos/app/index.tsx`). That
callback checks, in this order: close any open panel; an unknown code; the register counting or closing; a payment
taken; the receipt or a tender; then add. "Adds, line lit up" means the cart line for the item is highlighted
briefly (`cart-line-highlight-<SKU>`); "Cart tab lights up" means the narrow Cart tab's count and total tick up and
the tab is highlighted (`tab-cart-highlight`) while the Products tab stays shown.

| Surface | What a scan does | Where |
|---|---|---|
| Products tab (narrow), cart stage | Adds; the Cart tab lights up and Products stays shown. | `Sale`, `add(entry, !onProducts)` |
| Cart tab (narrow), cart stage | Adds, line lit up. | `Sale`, `add` |
| Wide layout, cart stage | Adds, line lit up. | `Sale`, `add` |
| Orders panel open | Closes the panel; on narrow switches to the Cart tab; adds, line lit up. | `Sale`, `panelOpen` → `onClosePanels`, `setTab('cart')` |
| Register panel open (session open, not counting) | Closes the panel; on narrow switches to the Cart tab; adds, line lit up. | `Sale`, `panelOpen` → `onClosePanels`; `RegisterPanel` mounts only while open |
| Cash-movement sheet open, focus off its fields | Closes the sheet and the Register panel under it (it does not come back when the panel is reopened), then as for the Register panel. | `Sale`, `onClosePanels`; `SignedInCatalogue` mounts `RegisterPanel` only while open |
| Cash-movement sheet open, focus in the reason | The field keeps the keys (the code is typed into it); nothing is added. | `useWedgeScanner` leaves non-money inputs alone |
| Focus in a money field (counted cash or a counted tender, cash tendered, the float, a movement amount, a discount value) | A scanner-fast burst ended by a fast Enter is a scan (Front desk, 2026-09-30: a barcode in an amount is a money error): the field is left as it was, its Enter goes no further, and the row for the surface applies (counting gives `scan-finish-closing`, a tender with cash typed `scan-finish-sale`, an unknown code `scan-not-found`). Typing at human speed, Enter included, stays typing. A money field is an `<input inputmode="decimal">`: TallyUI's amount inputs all take `keyboardType="decimal-pad"` (or `inputMode="decimal"`), which react-native-web renders so, and no text field does. | `useWedgeScanner`: the burst's first key types, the fast keys after it are held back, and the scan puts the value from before the burst back (native value setter, then an `input` event, so the controlled field agrees) |
| Register counting or closing (session `counting`, a close in flight or unwritten, or the Z sheet `ClosureSheet` showing) | Adds nothing; shows "Finish closing the register before scanning." (`scan-finish-closing`) until the register is done. The Z sheet stays open; while it shows, the notice shows over it (a `Portal`, below the sheet's `closure-unsynced` note). | `Sale`, `registerClosing` → `setScanNotice('finish-closing')`; `overSheet` → `Portal` |
| Tender, no payment | Goes back to the cart (Back to the cart), then adds, line lit up where the cart shows. | `Sale`, `sale.cancelTender()` |
| Tender with a payment (cash typed, a card tender started) or saving | Changes nothing; shows "Finish this sale before scanning the next item." (`scan-finish-sale`) until the tender ends. | `Sale`, `paying` → `setScanNotice('finish-sale')` |
| Receipt | Starts the next sale (New sale), then adds, line lit up where the cart shows. | `Sale`, `sale.newSale()` |
| No open register session | Adds as on the tab shown: only Pay waits for the register to open. | `Sale`, `add`; `OpenRegisterCard` in place of Pay |
| Focus in the Products search field | The search's own Enter looks the code up and adds it once; the wedge listener leaves it alone. The same holds for any other non-money text field (a movement reason, the sign-in fields, a note): the field keeps the keys. | `Catalogue` search; `useWedgeScanner` |
| An unknown code (any surface) | Closes a panel or sheet as a found code would, then shows `No products match "<code>".` (`scan-not-found`); nothing else changes: the stage, cart and tab stay as they are. | `Sale`, `!entry` → `setScanNotice({ notFound })` |

## A new surface

A new surface inherits a row rather than getting its own ruling:

- **It covers the sale and can be dismissed without losing anything** (a panel, a sheet, a dialog): the Orders panel
  row. Close it (add it to `panelOpen` / `onClosePanels`), then add with the line lit up.
- **The sale or the register is being finished on it** (money has moved, a count is in progress): the counting or
  tender-with-a-payment row. Add nothing and show a notice saying what to finish.
- **It has a text field with the focus:** the field keeps the keys, unless it is a money field (an amount input takes
  `keyboardType="decimal-pad"`): then the money-field row applies.
