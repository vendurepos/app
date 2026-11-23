import { describe, expect, it } from 'vitest';
import { TALLY_DISCOUNT_SKU, TALLY_FEE_SKU, TALLY_ROUNDING_SKU } from '../src/service/constants';
import { lineTotalsForRefund, roundingForRefund } from '../src/service/refund-line-totals';

// #460: a pure unit test (no Postgres), kept under test/ like classification.e2e.ts so vitest's include finds it.
describe('lineTotalsForRefund (#460)', () => {
  const a = { id: 1, quantity: 2, proratedLinePriceWithTax: 2000 };
  const b = { id: 2, quantity: 1, proratedLinePriceWithTax: 500 };
  const discount = { id: 7, sku: TALLY_DISCOUNT_SKU, priceWithTax: -250 };
  const fee = { id: 8, sku: TALLY_FEE_SKU, priceWithTax: 100 };
  const legacy = JSON.stringify({ display: {}, taxByRate: [] });
  const linked = (lineDiscounts: Record<string, string>) => JSON.stringify({ display: {}, taxByRate: [], lineDiscounts });
  const none = () => 0;
  // The totals as a plain object keyed by line id, or the refusal as it is.
  const run = (lines: Array<typeof a>, surcharges: Array<typeof discount>, tallySnapshot: string | null | undefined,
    payload: Array<[typeof a, number]>, refundedOf: (line: typeof a) => number = none, previousHadLines = false) => {
    const result = lineTotalsForRefund({ lines, surcharges, customFields: { tallySnapshot } },
      payload.map(([line, quantity]) => ({ line, quantity })), refundedOf, previousHadLines);
    return 'totals' in result ? Object.fromEntries(result.totals) : result;
  };

  it('a linked discount comes off its own line only', () => {
    expect(run([a, b], [discount, fee], linked({ 1: '7' }), [[b, 1]])).toEqual({ 1: 1750, 2: 500 });
  });

  it('a linked order with a discount surcharge no link names is refused, never refunded undiscounted', () => {
    const surcharges = [discount, { id: 9, sku: TALLY_DISCOUNT_SKU, priceWithTax: -100 }];
    expect(run([a, b], surcharges, linked({ 1: '7' }), [[b, 1]])).toEqual({ refuse: true });
    expect(run([a, b], surcharges, linked({ 1: '7' }), [[a, 2], [b, 1]])).toEqual({ refuse: true });
  });

  it('the rounding bridge goes with the refund that takes everything left on the lines, whatever its sign', () => {
    const bridge = { id: 11, sku: TALLY_ROUNDING_SKU, priceWithTax: -2 };
    const order = { lines: [a, b], surcharges: [bridge] };
    const whole = [{ line: a, quantity: 2 }, { line: b, quantity: 1 }];
    expect(roundingForRefund(order, whole, none)).toBe(-2);
    expect(roundingForRefund(order, [{ line: a, quantity: 1 }], none)).toBe(0);
    expect(roundingForRefund(order, [], none)).toBe(0);
    expect(roundingForRefund(order, [{ line: a, quantity: 1 }, { line: b, quantity: 1 }], line => line.id === a.id ? 1 : 0)).toBe(-2);
    expect(roundingForRefund({ ...order, surcharges: [{ ...bridge, priceWithTax: 3 }] }, whole, none)).toBe(3);
    expect(roundingForRefund({ ...order, surcharges: [discount, fee] }, whole, none)).toBe(0);
  });

  it('an empty link map leaves every line at its prorated total', () => {
    expect(run([a, b], [fee], linked({}), [[a, 1]])).toEqual({ 1: 2000, 2: 500 });
  });

  it('an order with no discounts refunds as before, whatever its snapshot', () => {
    for (const snapshot of [legacy, null, '{not json']) expect(run([a, b], [fee], snapshot, [[a, 1]], none, true)).toEqual({ 1: 2000, 2: 500 });
  });

  it('an unlinked one-line order puts every discount on its line', () => {
    expect(run([a], [discount, { ...discount, id: 9, priceWithTax: -50 }], legacy, [[a, 1]], none, true)).toEqual({ 1: 1700 });
  });

  it('an unlinked refund of everything remaining carries the discount sum on the highest line id', () => {
    expect(run([a, b], [discount], legacy, [[b, 1], [a, 2]])).toEqual({ 1: 2000, 2: 250 });
  });

  it('refuses an unlinked whole-remaining refund after an earlier line refund', () => {
    expect(run([a, b], [discount], legacy, [[a, 1], [b, 1]], line => (line.id === 1 ? 1 : 0), true)).toEqual({ refuse: true });
  });

  it('refuses an unlinked partial refund', () => {
    expect(run([a, b], [discount], legacy, [[a, 2]])).toEqual({ refuse: true });
    expect(run([a, b], [discount], undefined, [[a, 1], [b, 1]])).toEqual({ refuse: true });
  });

  it('refuses a link to a surcharge the order does not have', () => {
    expect(run([a, b], [discount], linked({ 1: '99' }), [[b, 1]])).toEqual({ refuse: true });
  });

  it('refuses unparsable snapshot JSON when the order has discounts', () => {
    expect(run([a, b], [discount], '{not json', [[a, 1]])).toEqual({ refuse: true });
  });
});
