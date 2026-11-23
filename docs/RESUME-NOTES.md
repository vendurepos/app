# VendurePOS resume notes: money lane (from worker bc6d025c, 2026-11-23)

Branch `docs/resume-notes-money-lane` only, so do not merge it. Read it with `git show origin/docs/resume-notes-money-lane:docs/RESUME-NOTES.md`. There is a copy at ~/agent/handoff/vendurepos-resume-2026-11-23.md.

## State
- **Merged today:**
  - P2 #4 is #472 (11859201).
  - P3 #8 is #474 (7a1a65ed): the README line on `TZ` and the database time zone at UTC. Issue #473 (store `tallySaleAt` as timestamptz) stays open, **parked by desk ruling**: do not work it.
  - P3 #7 is #476 (36fe4f38): a bridge over max(2, lines + surcharges + shipping lines) is refused `total_mismatch`, unstored. No tag, no publish.
- **Plugin 0.4.0:** the release hook refused the plugin-v0.4.0 tag. It **waits on Paul**: do not tag, retry or work around it.
- **Open PRs:** none from this machine.
- **The worktree name is misleading.** `.claude/worktrees/fix-463-private-collections` (locked) holds only this notes branch, based on 36fe4f3 = origin/main. **No #463 work exists anywhere.**
- **No unpushed work.** `test/money-p1-discounted-refund` is already in origin/main.
- **Filed today:** TallyUI/tallyui#1283, for the TallyUI repo's own worker. The vendored `src/vendored/commands.ts` comments ("a warning never rejects a sale", and the fee `taxMinor` "not a refusal") are stale after #476. Never hand-edit `src/vendored/*`; they change on the next pin bump.

## Next, in order (source: ~/agent/handoff/fable-reviews-2026-11-22/vendurepos-money-paths.md §5, §6)
- **P3 #5: till-only Reports misattribute refunds.** App only, door:two-way.
  - **Where:** `apps/pos/lib/till-reports.ts:75-80`. With a cashier or status filter, a refund is kept only if its *order* passed the filter (`keptIds`).
  - **The bug:** a refund that cashier B made on cashier A's sale counts under A, and a refund whose order isn't on this device disappears.
  - **What the store report does:** the store route (`packages/vendure-plugin/src/service/report.service.ts`) counts a refund under the cashier who made it. Match it.
  - **Test first** in `apps/pos/lib/till-reports.test.ts`: "with a cashier filter, a refund counts for the cashier who made it, as the store report does".
  - **Status filter:** the review names only the cashier case. Decide how a status filter treats a refund from the store route's behaviour, and write it in the spec.
- **P3 #6: report "Discounts" mixes tax bases.** Plugin and money, **door:one-way, READY to desk**, with an Opus re-derive before READY.
  - **The bug:** `report.service.ts:86` and `:223` compute `SUM(0 - s.listPrice)`. From v4 the POS discount surcharge's `listPrice` is net, while `sales` is gross (`subTotalWithTax + shippingWithTax`). So on an inclusive store, 2.00 off shows as 1.82. v2 and v3 orders are in their line's own mode, so one figure mixes bases.
  - **Where the figure is shown:** `apps/pos/lib/store-sales.ts`, `sales-csv.ts`, `sales-summary-lines.ts`, all unchanged.
  - **Test** in `packages/vendure-plugin/test/sales-report*.e2e.ts`: "discountsMinor for a v4 tax-inclusive sale is the gross amount taken off the receipt".
  - **The one-way call:** whether historic v2/v3 rows are converted (and how) or only v4+ is changed. That is the desk's call. Bring it with a recommendation **before** writing the spec.
  - Check it against TallyUI#1279: on the sales report, net is now gross − tax − rounding.
- **#463: private collections in v3 `categories` rows.** Get a **desk ruling first**.
  - The issue says to leave out `isPrivate` and root collections.
  - But `test/sales-report-v3.e2e.ts:196` deliberately asserts that private "Gifts" **is** a row, "as the app's category tiles keep private collections".
  - The two contradict each other. Ask the desk which wins; changing the test silently would revert a recorded choice.
- **#461:** the customer sheet's billing-address Email is never saved, because Vendure addresses have no email field. Bug, unassigned: ask before taking it.
- **#475** (ada, claimed:mini): the till's needs-admin refund notice and Check again. It **waits until TallyUI#1280 is published**.
- **#469:** a negative bridge larger than the last line refuses that line's final refund. #476 now caps the bridge at max(2, lines), which may shrink or close it: re-measure before speccing.
- **Nothing to do yet:** TallyUI#1279 merged, and the closure template can print `closure.cash_rounding` once the app bumps to that @tallyui/pos minor.

## What a new worker gets wrong
- **Plugin package:** `packages/vendure-plugin` is npm, outside the pnpm workspace (`npm ci`, `npx tsc --noEmit -p tsconfig.json`).
- **Running the e2e suite:**
  - Steps: `npm run db:up`, then `~/.claude/bin/test-slot-run --wait 600 npx vitest run <files> --maxWorkers=1`, then `npm run db:down`.
  - The full suite (683 tests) takes about 630 s. Run it as `--shard=1/2` and `--shard=2/2`.
  - Run `npm run build` first, or `dashboard-packaging`, `email-smtp` and `receipt-email` fail.
- **Git:** `cd` combined with git, `git -C` and chained git commands are refused by the isolation hook. Run plain git commands from the worktree.
- **Refusal kinds:**
  - **Unstored refusals** throw `SetupRefusal` inside the one `withTransaction`; `runSale` rethrows it, so it never becomes `needs_admin`.
  - **Stored refusals** (`unknown_variant`, `underpaid`) go on the ledger claim.
- **Codex:** `~/.claude/bin/codex-job.sh --timeout 540 <worktree> <spec>`. Read `~/.claude/state/route-implementation` first (it said `codex`). Commit the Codex output before running mutation scripts.
- **Reading #463, #461 and other GitHub items:** use `~/.claude/bin/gh-read.sh`. A raw `gh issue view` 404s through the guard.
