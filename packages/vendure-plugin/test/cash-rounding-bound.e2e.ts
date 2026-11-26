import { describe, expect, it } from 'vitest';
import { cashRoundingRefusal } from '../src/service/cash-rounding';
import type { TenderMethod, TenderPayment } from '../src/service/payment-methods.service';

// F5's guarantee, |Σ| ≤ 16 × (B − 1), against the real cashRoundingRefusal with no server and no database: a beam search
// over the extreme entries the running-sum (ruling 6) and last-entry prefix (ruling 7) acceptances let through.
const method = (code: string, incrementMinor: number): TenderMethod => ({ code, name: code, kind: 'cash', rounding: { incrementMinor, mode: 'nearest' } });
const channels = [
  { name: 'cash-5 + cash-10', listed: [method('cash-5', 5), method('cash-10', 10)], methodId: 'cash-10', B: 20, max: 304 },
  { name: 'cash-5 only', listed: [method('cash-5', 5)], methodId: 'cash-5', B: 10, max: 144 },
];

/** cashRoundingRefusal for one leg of 10000 per entry, each entry on its own leg in payload order. */
function refusal(minors: number[], listed: TenderMethod[], methodId: string) {
  const payments: TenderPayment[] = minors.map((_, index) => ({ clientPaymentId: `p${index}`, method: 'cash', methodId, amountMinor: 10000 }));
  const payload = { totalMinor: payments.reduce((sum, payment) => sum + payment.amountMinor, 0), payments,
    cashRoundings: minors.map((minor, index) => ({ paymentId: `p${index}`, minor })) };
  return cashRoundingRefusal(payload, payments.map(payment => payment.methodId!), listed);
}

type State = { minors: number[]; P: number; lo: number; hi: number };

/** The largest |Σ| over the accepted sequences of length 1…16 the beam reaches. */
function beamMaxSum(listed: TenderMethod[], methodId: string, B: number): number {
  let beam: State[] = [{ minors: [], P: 0, lo: 0, hi: 0 }];
  let best = 0;
  for (let length = 1; length <= 16; length++) {
    const next = new Map<string, State>();
    for (const { minors, P, lo, hi } of beam) {
      const candidates = new Set([B - 1, -(B - 1), B - 1 - lo, -(B - 1) - hi, B - 1 - P, -(B - 1) - P]);
      for (const minor of candidates) {
        if (minor === 0) continue;
        const extended = [...minors, minor];
        if (refusal(extended, listed, methodId) !== undefined) continue;
        const sum = P + minor;
        best = Math.max(best, Math.abs(sum));
        const state = { minors: extended, P: sum, lo: Math.min(lo, sum), hi: Math.max(hi, sum) };
        const key = `${state.P},${state.lo},${state.hi}`;
        if (!next.has(key)) next.set(key, state);
      }
    }
    beam = [...next.values()].sort((a, b) => (b.P + b.hi - b.lo) - (a.P + a.hi - a.lo)).slice(0, 2000);
  }
  return best;
}

describe('cash rounding: F5 bounds Σ (rulings 6 and 7)', () => {
  for (const { name, listed, methodId, B, max } of channels) {
    it(`search: with ${name} (B ${B}) the largest accepted |Σ| is ${max}, reached by [${B - 1} ×16]`, () => {
      const started = Date.now();
      expect(beamMaxSum(listed, methodId, B)).toBe(max);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(max).toBe(16 * (B - 1));
      expect(refusal(Array.from({ length: 16 }, () => B - 1), listed, methodId)).toBeUndefined();
    });
  }

  it('the chain: the any-entry rule\'s 16-entry chain (Σ 3553) is refused at its third entry; its first three alone pass', () => {
    const { listed, methodId } = channels[0];
    const chain = [19, -38, -38, -38, 114, 114, 114, 114, -380, -380, -380, -380, 1178, 1178, 1178, 1178];
    expect(chain.reduce((sum, minor) => sum + minor, 0)).toBe(3553);
    expect(refusal(chain, listed, methodId)).toMatchObject({ code: 'total_mismatch', data: { cashRoundingMinor: -38, boundMinor: 20 } });
    expect(refusal(chain.slice(0, 3), listed, methodId)).toBeUndefined();
  });

  it('the replay: under cash-10 alone, F10\'s entries pass and F11\'s are refused at the +21', () => {
    const listed = [method('cash-10', 10)];
    const f10 = [-4, -4, -4, -4, 5, 5, 5, 21];
    expect(refusal(f10, listed, 'cash-10')).toBeUndefined();
    expect(refusal([...f10, 5], listed, 'cash-10')).toMatchObject({ code: 'total_mismatch', data: { cashRoundingMinor: 21, boundMinor: 20 } });
  });
});
