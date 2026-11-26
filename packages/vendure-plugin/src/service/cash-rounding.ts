// TallyUI ADR-094: order.create's `cashRoundings`, the till's cash rounding per payment. The plugin checks the entries
// against the channel's own rounding cash methods and never takes the till's figure on trust.
import type { CashRounding } from '../config/strategies';
import { CASH_ROUNDING_BOUND_FACTOR, MAX_CASH_ROUNDINGS } from './constants';
import type { TenderMethod, TenderPayment } from './payment-methods.service';

export type CashRoundingEntry = { paymentId: string; minor: number };
type CashPayload = { totalMinor: number; payments: TenderPayment[]; display?: { totalMinor: number }; cashRoundings?: unknown };
export type CashRoundingRefusal = { code: 'invalid_payload' | 'total_mismatch'; message: string; data?: Record<string, number> };

const entriesOf = (payload: CashPayload): CashRoundingEntry[] => Array.isArray(payload.cashRoundings) ? payload.cashRoundings : [];

/** Σ minor of the entries; 0 when there are none. */
export function cashRoundingSum(payload: CashPayload): number {
  return entriesOf(payload).reduce((sum, entry) => sum + entry.minor, 0);
}

/** The payload-only checks (F1, F2), each error naming its path; [] when cashRoundings is absent or empty. */
export function cashRoundingPayloadErrors(payload: CashPayload): string[] {
  const value = payload.cashRoundings;
  if (value === undefined || (Array.isArray(value) && !value.length)) return [];
  if (!Array.isArray(value) || value.length > MAX_CASH_ROUNDINGS) {
    return [`cashRoundings: expected an array of at most ${MAX_CASH_ROUNDINGS} entries`];
  }
  const errors: string[] = [];
  const ids = new Set(payload.payments.map(payment => payment.clientPaymentId));
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const path = `cashRoundings[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    const { paymentId, minor } = entry as Record<string, unknown>;
    if (typeof paymentId !== 'string' || !ids.has(paymentId)) errors.push(`${path}.paymentId: expected a payments[].clientPaymentId`);
    else if (seen.has(paymentId)) errors.push(`${path}.paymentId: expected no duplicate paymentId`);
    if (typeof paymentId === 'string') seen.add(paymentId);
    if (!Number.isSafeInteger(minor) || minor === 0) errors.push(`${path}.minor: expected a non-zero safe integer`);
  });
  if (!errors.length && payload.payments.reduce((sum, payment) => sum + payment.amountMinor, 0) !== payload.totalMinor) {
    errors.push('cashRoundings: the payments must add up to totalMinor exactly when the order carries cash rounding');
  }
  return errors;
}

/** The payload as it would be without the cash rounding (the goods total); the same object when the sum is 0. */
export function withoutCashRounding<P extends CashPayload>(payload: P): P {
  const sum = cashRoundingSum(payload);
  if (sum === 0) return payload;
  return { ...payload, totalMinor: payload.totalMinor - sum,
    ...(payload.display ? { display: { ...payload.display, totalMinor: payload.display.totalMinor - sum } } : {}) };
}

// Per entry, in payload order, the figures any one of which inside a limit explains it: the entry and the running sum
// through it (ruling 6) and, for the last entry only, itself plus each prefix sum before it (ruling 7).
function explainingFigures(entries: CashRoundingEntry[]): number[][] {
  const prefixes = [0];
  for (const { minor } of entries) prefixes.push(prefixes[prefixes.length - 1] + minor);
  return entries.map(({ minor }, index) => index < entries.length - 1 ? [minor, prefixes[index + 1]]
    : [minor, prefixes[index + 1], ...prefixes.slice(0, index + 1).map(prefix => minor + prefix)]);
}

// A payment's rounding leg: its own method's, or, for an unnamed cash leg (a content version below 10), every rounder's.
function roundingLegs(payload: CashPayload, codes: string[], listed: TenderMethod[], rounders: TenderMethod[]): CashRounding[][] {
  return payload.payments.map(({ method, methodId }, index) => {
    const own = listed.find(tally => tally.code === codes[index])?.rounding;
    if (own) return [own];
    return methodId === undefined && method === 'cash' ? rounders.map(tally => tally.rounding!) : [];
  });
}

/**
 * The store-config checks against the channel's methods, after resolve: F3 (a rounding leg is a multiple of one of its
 * increments), F4 (an entry on any other payment is a single negative write-off) and F5 (every entry is under
 * CASH_ROUNDING_BOUND_FACTOR × the largest enabled increment, or its running sum is). The first failure, or undefined.
 */
export function cashRoundingRefusal(payload: CashPayload, codes: string[], listed: TenderMethod[]): CashRoundingRefusal | undefined {
  const entries = entriesOf(payload);
  if (!entries.length) return undefined;
  const rounders = listed.filter(method => method.rounding);
  if (!rounders.length) return { code: 'invalid_payload', message: 'cashRoundings: no enabled cash method of this channel rounds' };
  const increments = roundingLegs(payload, codes, listed, rounders).map(leg => leg.map(rounding => rounding.incrementMinor));
  for (const [index, payment] of payload.payments.entries()) {
    if (increments[index].length && !increments[index].some(increment => payment.amountMinor % increment === 0)) {
      return { code: 'invalid_payload', message: `payments[${index}].amountMinor: a cash rounding leg must be a multiple of its increment` };
    }
  }
  // Front desk ruling 2026-11-26: a write-off's mode, increment and position are not checked; the till's voided legs
  // are not on the wire.
  let writeOffs = 0;
  for (const [index, entry] of entries.entries()) {
    if (increments[payload.payments.findIndex(payment => payment.clientPaymentId === entry.paymentId)].length) continue;
    if (entry.minor >= 0 || ++writeOffs > 1) {
      return { code: 'invalid_payload',
        message: `cashRoundings[${index}]: an entry on a payment that is not a rounding cash method must be a single negative write-off` };
    }
  }
  // F5: an entry is over only when it and the running sum through it (in payload order) are both at the bound or above.
  // The running-sum acceptance is front desk ruling 6 of 2026-11-26 (TallyUI#1367: a reopened sale's settle carries back
  // the earlier picks).
  // The last entry also passes when it plus some prefix sum before it is inside: front desk ruling 7 of 2026-11-26
  // (TallyUI#1367: a reopened sale's settle carries back the reopened entries but not the new picks'). So F5 keeps
  // |Σ| ≤ 16 × (B − 1), B the bound. Both acceptances go at order.create v13 (a per-entry rounding basis, TallyUI#1367)
  // for the exact per-entry check.
  const boundMinor = CASH_ROUNDING_BOUND_FACTOR * Math.max(...rounders.map(tally => tally.rounding!.incrementMinor));
  const figures = explainingFigures(entries);
  const over = entries.find((_, index) => figures[index].every(figure => Math.abs(figure) >= boundMinor));
  if (over) {
    return { code: 'total_mismatch', data: { cashRoundingMinor: over.minor, boundMinor },
      message: `Cash rounding of ${over.minor} on payment ${over.paymentId} is more than this channel allows (under ${boundMinor}, `
        + 'twice its largest cash increment). A till that voided tenders after a cash write-off can produce this (TallyUI#1365). '
        + 'Reopen the sale on the till and take the payment again.' };
  }
  return undefined;
}

/**
 * The hull of the leg's ranges R in minor units: nearest (−inc/2, inc/2], up [0, inc), down (−inc, 0].
 * For a write-off, take the hull over all enabled rounders (front desk ruling, 2026-11-26).
 */
function roundingRange(roundings: CashRounding[]) {
  const posMax = ({ incrementMinor: inc, mode }: CashRounding) => ({ nearest: Math.floor(inc / 2), up: inc - 1, down: 0 }[mode]);
  const negMax = ({ incrementMinor: inc, mode }: CashRounding) => ({ nearest: Math.ceil(inc / 2) - 1, up: 0, down: inc - 1 }[mode]);
  return { low: -Math.max(...roundings.map(negMax)), high: Math.max(...roundings.map(posMax)) };
}

/**
 * After cashRoundingRefusal passes, warn on entries whose running sum in payload order is outside their leg's R.
 * sumMinor is the running sum judged against [lowMinor, highMinor]; maxMinor is the magnitude of the crossed bound, and minor is the entry's own amount.
 */
export function cashRoundingUnexplained(payload: CashPayload, codes: string[], listed: TenderMethod[]): Array<
  CashRoundingEntry & { maxMinor: number; sumMinor: number; lowMinor: number; highMinor: number }> {
  const rounders = listed.filter(method => method.rounding);
  const legs = roundingLegs(payload, codes, listed, rounders);
  const roundings = rounders.map(tally => tally.rounding!);
  const entries = entriesOf(payload);
  let sum = 0;
  return entries.flatMap(({ paymentId, minor }) => {
    const leg = legs[payload.payments.findIndex(payment => payment.clientPaymentId === paymentId)];
    const { low, high } = roundingRange(leg.length ? leg : roundings);
    sum += minor;
    return sum < low || sum > high ? [{ paymentId, minor, maxMinor: sum < low ? -low : high, sumMinor: sum, lowMinor: low, highMinor: high }] : [];
  });
}
