# Cash rounding on Vendure: the plugin stores the till's rounded total and checks it with invariants, not a re-derive

Status: Accepted (front desk rulings of 2026-11-26)
Date: 2026-11-26

## Context

TallyUI ADR-094 lets a till round a cash payment to the channel's smallest coin. The till then sends the rounding in `payload.cashRoundings`, as `{ paymentId, minor }[]`, alongside the goods figures. The server must store an order whose total equals what the till took. It must also not let a till give itself a discount and call it rounding.

The plugin re-derives the rounding from its own payment-method increment and refuses a payload that disagrees. It never trusts the till's figure. TallyUI 5.0.0, however, does not put on the wire everything that re-derivation needs (TallyUI#1364):

- Voided and failed legs are dropped. `complete` sends only the legs that count toward paid, under fresh ids.
- A leg's `units` are not sent.
- A settle entry is computed against the entries live at that moment, including entries on legs that are voided later.

So the same payload can come from different sales whose correct entries differ. Four findings from replays on TallyUI's real order builder (2026-11-26):

- **Without voids**, a single entry is bounded. For a rounding m of increment inc, a pick or settle moves the amount by at most posMax(m) up (nearest floor(inc/2), since TallyUI rounds a half up; up inc − 1; down 0) and negMax(m) down (nearest ceil(inc/2) − 1; up 0; down inc − 1). A write-off is at most W, the largest negMax among the enabled methods, and TallyUI merges it into the last counted leg's own entry whatever that leg's method, so an entry on a rounding leg is at most max(posMax(m), negMax(m) + W). Every one of these is below 2 × the largest increment.
- **A reopened sale** re-adds its legs without `units` (TallyUI#1367), so its next settle entry carries every earlier pick entry back: four cash-10 picks of −4, then a settle of +21. When it takes new unit picks before the settle, those keep their own entries and the settle carries back only the reopened ones: four −4, three new +5, then +21, whose running sum is +20. The total is correct in both; only the single entry is past anything a till makes in one step. In the first sale the running sum through it is inside the bound; in the second only the entry plus the reopened prefix is (21 − 16 = 5).
- **With voids**, the #1295 sale `[card 497 {−3}, cash 510 {+2}]` finishes even though no rule on the payload alone explains its −3.
- **With voids, a write-off can grow without limit** (TallyUI#1365, a money bug). A write-off ignores entries on pick legs, so each "void a card, tap cash" cycle writes off another remainder.

## Decision

1. **Storage.** The rounding is one untaxed Vendure surcharge per order, SKU `TALLY-CASH-ROUNDING`, equal to Σ minor. It is outside the TALLY-ROUNDING bridge and its bound. The bridge reconciles the goods total, `totalMinor − Σ minor`, so the order total equals `payload.totalMinor` to the minor unit.
2. **Configuration.** A cash method's rounding increment and mode are handler args (P1a). They are listed in `/info`. The `cashRounding` capability gates the whole feature. `cashRoundings` is accepted at every content version, as in TallyUI core. A cash payment without a `methodId` (versions below 10) counts as a rounding leg under any enabled rounding method.
3. **Refused** (unstored, so a resend after a config fix is checked again):
   - shape: at most 16 entries, unique ids that each name a sent payment, each minor a non-zero safe integer;
   - Σ amount ≠ total;
   - a goods total outside the bridge bound;
   - a rounding cash leg that is not a multiple of its increment;
   - more than one entry, or a non-negative entry, on a payment that is not a rounding cash method;
   - an entry with |minor| ≥ 2 × the largest enabled increment whose running sum (the entries through it, in payload order) is at that bound too. This is refused as `total_mismatch`, which the till can reopen, with a message naming void cycles and TallyUI#1365. The running-sum acceptance is front desk ruling 6 (2026-11-26): a large entry passes only when it cancels what came before it, as a reopened sale's settle does (TallyUI#1367). The last entry also passes when it plus the sum of some prefix of the entries before it is inside the bound (front desk ruling 7, 2026-11-26): the settle of a reopened sale that took new picks first. Only the last entry, because a settle or a write-off ends the sale; the same acceptance on any entry lets Σ reach 3553 at cash-10 with 16 entries;
   - entries on a channel with no enabled rounding cash method.
4. **Loosened because voided legs are not on the wire.** A write-off on a non-rounding leg is accepted in any position, under any mode, and whatever its remainder rounds to. The #1295 sale, a write-off under an up-only channel and a half-increment write-off under nearest are therefore accepted. Each one carries the warning below.
5. **Warning, not refusal.** `cash_rounding_unexplained` (`{ paymentId, minor, maxMinor }`) is raised on an entry when the running sum of the entries through it, in payload order, is outside the range R of its leg's rounding (front desk ruling of 2026-11-26, after TallyUI #1372). It replaces the earlier per-entry void-free maximum of rulings 4 and 5. For a rounding m of increment inc, R is:
   - nearest: (−inc/2, inc/2], so [−(ceil(inc/2) − 1), floor(inc/2)] in minor units;
   - up: [0, inc − 1];
   - down: [−(inc − 1), 0].

   The leg's roundings are its method's rounding on a rounding leg. On an unnamed cash leg and on any other leg (a write-off), they are every enabled rounding method's, and R is the hull of their ranges. `maxMinor` is the side of R that the sum crossed: its high end when the sum is above R, and the size of its low end when it is below.

   TallyUI keeps a sale's running cash rounding inside R. A carried pick (a later pick whose entry, up to one increment less a cent, brings the sum back inside R) is therefore silent, and so is any entry whose running sum is inside R, whatever its own size and position. A sum outside R warns on every entry where it is outside. That includes a sale stored before TallyUI carried picks, which rounded each pick on its own. There is no per-entry rounding basis on the wire (TallyUI#1368 closed), so the running sum is the plugin's only figure.

   The sale is still applied with its total unchanged. The warning is returned in the order.create result, stored in the order's `tallySnapshot` as `cashRoundingUnexplained`, and written as one private order note that the Vendure admin shows. The sales report's cash-rounding figure (`GET /tally/v1/reports/sales/v4`) counts these sales as `unexplainedOrderCount`.
6. **Refunds.** A full refund returns the rounding. A partial refund returns none of it, except the refund that takes everything left on the lines, which carries all of it, as it carries the TALLY-ROUNDING bridge. A negative rounding larger than the last line, or a partial refund of a line above what was paid, is refused there as for the bridge (#469, accepted: that last line is refunded in the Vendure admin). The refund command records the cash part it returns (never the bridge) as `tallyCashRoundingMinor` on its first Vendure Refund, the only record of it, and the v4 sales report nets those refunds: `cashRounding.netMinor` is the sales' rounding less the refunds', each dated by its own event. A Vendure-dashboard refund carries no key, so it returns none in the report even when it repays the rounding.
7. **Old servers.** A till talking to a plugin without the capability takes exact cash and keeps no local-only rounding.

## Consequences

- An order's stored total always equals what the till took. Any sale whose running cash rounding leaves its mode's range R is visible to the merchant.
- **What F5 guarantees.** With B = 2 × the largest enabled increment, every accepted sale has |Σ minor| ≤ 16 × (B − 1), 16 being the entry cap: 3.04 in a 2-decimal currency with cash-10 enabled (B 20), 1.44 with cash-5 only (B 10). That is all the discount a till can disguise as rounding in one sale. The proof: by induction every prefix sum is at most i × (B − 1), since each entry is either under B or brings the running sum under B; a last entry that cancels prefix k adds at most (B − 1) + |P_k| over the last point the running sum was under B. `test/cash-rounding-bound.e2e.ts` searches the accepted payloads and asserts 304 and 144.
- **Why B − 1 per entry and not one increment.** A void-free entry already reaches max(posMax(m), negMax(m) + W): −6 on a cash-5 leg with cash-10 on, −8 or +5 on cash-10, inc − 1 + W under up. Voids and the reopened settles go past that, and no refusal may hit a sale a till makes without voids (front desk ruling 5). The wire does not say which amount an entry rounded, so the plugin can only bound its size, not check it.
- **These rules are a stopgap for order.create below v13** (the plugin accepts up to v11 today). TallyUI is adding a per-entry rounding basis at order.create v13, which replaces `units` on the wire. When vendurepos raises its cap to v13, F5 becomes the exact per-entry check (each entry is its basis rounded under its method, minus the basis), and the running-sum and last-entry prefix rules are deleted.
- A sale hit by TallyUI#1365 stays in the till's outbox as a reopenable `total_mismatch` instead of storing an undercharge.
- **Tightening back.** Item 4 and the running-sum range in item 5 exist only because TallyUI 5.0.0 does not send voided legs or `units`. When TallyUI#1364 puts them on the wire:
  - the plugin's exact in-order re-derive replaces the range check;
  - the write-off rule returns to the desk's original shape: the remainder rounds to 0 under an enabled method, and the entry sits on the last counted leg.

  F5's running-sum and last-entry prefix acceptances in item 3 go with the v13 per-entry check above (TallyUI#1367). When TallyUI#1365 is fixed, the hard bound can tighten to the void-free maximum.
- Medusa and the Woo fork face the same limit and can take the same invariants.
