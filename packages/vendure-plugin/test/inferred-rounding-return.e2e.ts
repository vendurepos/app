import { describe, expect, it } from 'vitest';
import { inferredRoundingReturnId } from '../src/service/report.service';

describe('inferredRoundingReturnId', () => {
  const t0 = new Date(0);
  const t1 = new Date(1000);

  it('returns null for an empty history', () => {
    expect(inferredRoundingReturnId([], 1000)).toBeNull();
  });

  it('returns null for zero or negative settled payments', () => {
    const history = [{ id: '1', createdAt: t0, total: 1000, keyed: false }];
    expect(inferredRoundingReturnId(history, 0)).toBeNull();
    expect(inferredRoundingReturnId(history, -5)).toBeNull();
  });

  it('rules out inference even when the keyed refund follows full repayment', () => {
    expect(inferredRoundingReturnId([
      { id: '1', createdAt: t0, total: 1000, keyed: false },
      { id: '2', createdAt: t1, total: 100, keyed: true },
    ], 1000)).toBeNull();
  });

  it('orders refunds by creation time before accumulating totals', () => {
    expect(inferredRoundingReturnId([
      { id: '1', createdAt: t1, total: 400, keyed: false },
      { id: '2', createdAt: t0, total: 600, keyed: false },
    ], 1000)).toBe('1');
  });

  it('breaks creation-time ties by numeric id', () => {
    expect(inferredRoundingReturnId([
      { id: '10', createdAt: t0, total: 500, keyed: false },
      { id: '9', createdAt: t0, total: 500, keyed: false },
    ], 1000)).toBe('10');
  });

  it('counts an exact repayment but not one minor unit less', () => {
    const refund = { id: '1', createdAt: t0, total: 1000, keyed: false };
    expect(inferredRoundingReturnId([refund], 1000)).toBe('1');
    expect(inferredRoundingReturnId([{ ...refund, total: 999 }], 1000)).toBeNull();
  });

  it('returns the refund that takes the total past the settled amount', () => {
    expect(inferredRoundingReturnId([
      { id: '1', createdAt: t0, total: 400, keyed: false },
      { id: '2', createdAt: t1, total: 700, keyed: false },
    ], 1000)).toBe('2');
  });

  it('leaves the input array in its original order', () => {
    const history = [
      { id: '1', createdAt: t1, total: 400, keyed: false },
      { id: '2', createdAt: t0, total: 600, keyed: false },
    ];
    inferredRoundingReturnId(history, 1000);
    expect(history.map(refund => refund.id)).toEqual(['1', '2']);
  });
});
