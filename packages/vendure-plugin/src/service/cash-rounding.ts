// TallyUI ADR-094: order.create's `cashRoundings`, the till's cash rounding per payment. The plugin checks the entries
// against the channel's own rounding cash methods and never takes the till's figure on trust.
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

/**
 * The store-config checks against the channel's methods, after resolve: F3 (a rounding leg is a multiple of one of its
 * increments), F4 (an entry on any other payment is a single negative write-off) and F5 (every entry is under
 * CASH_ROUNDING_BOUND_FACTOR × the largest enabled increment). The first failure, or undefined.
 */
export function cashRoundingRefusal(payload: CashPayload, codes: string[], listed: TenderMethod[]): CashRoundingRefusal | undefined {
  const entries = entriesOf(payload);
  if (!entries.length) return undefined;
  const rounders = listed.filter(method => method.rounding);
  if (!rounders.length) return { code: 'invalid_payload', message: 'cashRoundings: no enabled cash method of this channel rounds' };
  // A payment's increments: its own method's, or, for an unnamed cash leg (a content version below 10), every rounder's.
  const increments = payload.payments.map(({ method, methodId }, index) => {
    const own = listed.find(tally => tally.code === codes[index])?.rounding;
    if (own) return [own.incrementMinor];
    return methodId === undefined && method === 'cash' ? rounders.map(tally => tally.rounding!.incrementMinor) : [];
  });
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
  const boundMinor = CASH_ROUNDING_BOUND_FACTOR * Math.max(...rounders.map(tally => tally.rounding!.incrementMinor));
  const over = entries.find(entry => Math.abs(entry.minor) >= boundMinor);
  if (over) {
    return { code: 'total_mismatch', data: { cashRoundingMinor: over.minor, boundMinor },
      message: `Cash rounding of ${over.minor} on payment ${over.paymentId} is more than this channel allows (under ${boundMinor}, `
        + 'twice its largest cash increment). A till that voided tenders after a cash write-off can produce this (TallyUI#1365). '
        + 'Reopen the sale on the till and take the payment again.' };
  }
  return undefined;
}
