# Tap targets on the phone till

These are tap-target sizes on the till at phone width. They were measured on 16 Nov 2026, after Scale landed (#251), at the request of the front desk.

**How they were measured:** in the demo web build at 390×844 in Playwright Chromium, from each control's `getBoundingClientRect()`, in CSS px. The sizes come from TallyUI 3.20's components and its scale tokens.

- **Auto** is Compact at this width (`--text-base` 13px).
- **Regular** is how the app looked before #251 (14px).

| Control | Compact (Auto) | Regular |
|---|---|---|
| Menu button (`register-bar-menu`) | 35×35 | 40×40 |
| Cashier avatar (`register-bar-cashier`) | 28×28 | 32×32 |
| Products / Cart tabs | 185×27 | 183×30 |
| Camera scan button | 35×35 | 40×40 |
| Grid / Table toggle | 46×30, 52×30 | 50×34, 57×34 |
| Category chips | 49–91 × 27 | 54–99 × 30 |
| Product tiles | 185×180 | 183×189 |

## What this shows

- **Product tiles** are well above 44 px at both scales.
- **The other controls** are all under the 44 px touch-target guideline (Apple's HIG; Material asks for 48 dp), even at Regular.
- **Compact** takes another 3–5 px off each of them.
- **All of them** still clear WCAG 2.2 AA's 24 px minimum (2.5.8).

These are TallyUI components, sized by TallyUI's scale tokens, so the fix is platform-neutral and belongs in TallyUI, not in this app. One way to fix it is a minimum hit area of 44 px under `pointer: coarse`.

Until then, a guard test at 44 px would fail against what ships today, so none is added here.
