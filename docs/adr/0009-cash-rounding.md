# Cash rounding on Vendure: the plugin stores the till's rounded total and checks it with invariants, not a re-derive

Status: Accepted (front desk rulings of 2026-11-26)
Date: 2026-11-26

## Context

TallyUI ADR-094 lets a till round a cash payment to the channel's smallest coin. The till then sends the rounding in `payload.cashRoundings`, as `{ paymentId, minor }[]`, alongside the goods figures. The server must store an order whose total equals what the till took. It must also not let a till give itself a discount and call it rounding.

The plugin re-derives the rounding from its own payment-method increment and refuses a payload that disagrees. It never trusts the till's figure. TallyUI 5.0.0, however, does not put on the wire everything that re-derivation needs (TallyUI#1364):

- Voided and failed legs are dropped. `complete` sends only the legs that count toward paid, under fresh ids.
- A leg's `units` are not sent.
- A settle entry is computed against the entries live at that moment, including entries on legs that are voided later.

So the same payload can come from different sales whose correct entries differ. Three findings from replays on TallyUI's real order builder (2026-11-26):

- **Without voids**, a single entry is bounded. For a rounding m of increment inc, a pick or settle moves the amount by at most posMax(m) up (nearest floor(inc/2), since TallyUI rounds a half up; up inc − 1; down 0) and negMax(m) down (nearest ceil(inc/2) − 1; up 0; down inc − 1). A write-off is at most W, the largest negMax among the enabled methods, and TallyUI merges it into the last counted leg's own entry whatever that leg's method, so an entry on a rounding leg is at most max(posMax(m), negMax(m) + W). Every one of these is below 2 × the largest increment.
- **A reopened sale** re-adds its legs without `units` (TallyUI#1367), so its next settle entry carries every earlier pick entry back: four cash-10 picks of −4, then a settle of +21. The sale's total is correct; only the single entry is past anything a till makes in one step, and the running sum of entries through it is not.
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
   - an entry with |minor| ≥ 2 × the largest enabled increment whose running sum (the entries through it, in payload order) is at that bound too. This is refused as `total_mismatch`, which the till can reopen, with a message naming void cycles and TallyUI#1365. The running-sum acceptance is front desk ruling 6 (2026-11-26): a large entry passes only when it cancels what came before it, as a reopened sale's settle does (TallyUI#1367);
   - entries on a channel with no enabled rounding cash method.
4. **Loosened because voided legs are not on the wire.** A write-off on a non-rounding leg is accepted in any position, under any mode, and whatever its remainder rounds to. The #1295 sale, a write-off under an up-only channel and a half-increment write-off under nearest are therefore accepted. Each one carries the warning below.
5. **Warning, not refusal.** `cash_rounding_unexplained` (`{ paymentId, minor, maxMinor }`) is raised when an entry's |minor| and the running sum through it both exceed the void-free maximum for its leg (`voidFreeMaxMinor` in `src/service/cash-rounding.ts`):
   - on a rounding leg, the largest max(posMax(m), negMax(m) + W) over its method's rounding;
   - on an unnamed cash leg, the same over every enabled rounding method;
   - on any other leg (a write-off), W.

   The sale is still applied with its total unchanged. The warning is returned in the order.create result, stored in the order's `tallySnapshot` as `cashRoundingUnexplained`, and written as one private order note that the Vendure admin shows. The report's cash-rounding figure counts it in its note (a later PR). Below those maxima it stays silent: a pick sale is normal and is not flagged.
6. **Refunds.** A full refund returns the rounding. A partial refund returns none of it, except the refund that takes everything left on the lines, which carries all of it, as it carries the TALLY-ROUNDING bridge. A negative rounding larger than the last line, or a partial refund of a line above what was paid, is refused there as for the bridge (#469, accepted: that last line is refunded in the Vendure admin). The report's cash-rounding figure nets refunds (a later PR).
7. **Old servers.** A till talking to a plugin without the capability takes exact cash and keeps no local-only rounding.

## Consequences

- An order's stored total always equals what the till took. Any discount a till could disguise as rounding is bounded at under 2 × the largest increment per entry, and anything above the void-free maximum is visible to the merchant.
- A sale hit by TallyUI#1365 stays in the till's outbox as a reopenable `total_mismatch` instead of storing an undercharge.
- **Tightening back.** Item 4 and the threshold warning in item 5 exist only because TallyUI 5.0.0 does not send voided legs or `units`. When TallyUI#1364 puts them on the wire:
  - the plugin's exact in-order re-derive replaces the warning threshold;
  - the write-off rule returns to the desk's original shape: the remainder rounds to 0 under an enabled method, and the entry sits on the last counted leg.

  When reopen carries `units` (TallyUI#1367), the running-sum acceptance in items 3 and 5 tightens back to the per-entry rule. When TallyUI#1365 is fixed, the hard bound can tighten to the void-free maximum.
- Medusa and the Woo fork face the same limit and can take the same invariants.
