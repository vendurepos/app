import { describe, expect, it, vi } from 'vitest';
import type { SalesFigures } from '@tallyui/pos';
import type { SalesReportV2 } from './sales-report';
import { NO_MARGIN, reportsView, storeHourly, storeSalesFigures, whileFetching, type Spread, type StoreSales } from './store-sales';

const DAY = { from: '2026-11-20', to: '2026-11-20' };
const BEFORE = { from: '2026-11-19', to: '2026-11-19' };
const EMPTY = {
  version: 2 as const, timezone: 'UTC', currencyCode: 'EUR', registerId: null, cashierId: null,
  refunds: { count: 0, totalMinor: 0, orderCount: 0 }, byMethod: [], byDay: [], byHour: [], products: [], productsTruncated: false, taxes: [],
};
// 2026-11-20 in UTC. orders.taxMinor (620) is one cent off the tax rows' 621 on purpose.
const REPORT: SalesReportV2 = {
  ...EMPTY, from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z',
  orders: { count: 3, salesMinor: 4521, taxMinor: 620, discountsMinor: 150, itemCount: 5 },
  refunds: { count: 1, totalMinor: 952, orderCount: 1 },
  byMethod: [
    { method: 'card', salesMinor: 2569, refundsMinor: 0, orderCount: 2, refundCount: 0 },
    { method: 'cash', salesMinor: 1952, refundsMinor: 0, orderCount: 1, refundCount: 0 },
    { method: 'voucher', salesMinor: 0, refundsMinor: 952, orderCount: 0, refundCount: 1 },
  ],
  byDay: [{ day: '2026-11-20', orderCount: 3, salesMinor: 4521, refundsMinor: 952 }],
  byHour: [
    { hour: '2026-11-20T09', orderCount: 1, salesMinor: 1952, refundsMinor: 0 },
    { hour: '2026-11-20T14', orderCount: 2, salesMinor: 2569, refundsMinor: 952 },
  ],
  products: [
    { productVariantId: '7', sku: 'TOTE', name: 'Tote', quantity: 3, salesMinor: 2767 },
    { productVariantId: '1', sku: 'TALLY-MUG', name: 'Tally Fixture Mug', quantity: 2, salesMinor: 1904 },
  ],
  taxes: [
    { description: '7%', ratePercent: 7, baseMinor: 1000, taxMinor: 70 },
    { description: '19%', ratePercent: 19, baseMinor: 2900, taxMinor: 551 },
  ],
};
// 2026-11-19: one order.
const COMPARE: SalesReportV2 = {
  ...EMPTY, from: '2026-11-19T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z',
  orders: { count: 1, salesMinor: 1000, taxMinor: 160, discountsMinor: 0, itemCount: 1 },
  taxes: [{ description: '19%', ratePercent: 19, baseMinor: 840, taxMinor: 160 }],
  byHour: [{ hour: '2026-11-19T09', orderCount: 1, salesMinor: 1000, refundsMinor: 0 }],
  byDay: [{ day: '2026-11-19', orderCount: 1, salesMinor: 1000, refundsMinor: 0 }],
};

describe('storeSalesFigures', () => {
  it('maps the v2 report to SalesFigures in exact cents', () => {
    const figures = storeSalesFigures(REPORT, COMPARE, DAY, BEFORE);
    expect(figures.totals).toEqual({ grossMinor: 4521, netMinor: 3900, taxMinor: 621, discountMinor: 150, refundsMinor: 952,
      embeddedRefundsMinor: 0, orderCount: 3, averageMinor: 1507, items: 5, margin: NO_MARGIN });
    expect('medianMinor' in figures.totals).toBe(false);
    expect('largestMinor' in figures.totals).toBe(false);
    expect(figures.products).toEqual([
      { key: '7', name: 'Tote', quantity: 3, netMinor: 2767, margin: NO_MARGIN },
      { key: '1', name: 'Tally Fixture Mug', quantity: 2, netMinor: 1904, margin: NO_MARGIN },
    ]);
    expect(figures.taxes).toEqual([
      { key: '[190000,"19%"]', ratePpm: 190000, label: '19%', taxMinor: 551, netMinor: 2900 },
      { key: '[70000,"7%"]', ratePpm: 70000, label: '7%', taxMinor: 70, netMinor: 1000 },
    ]);
    expect(figures.refunds).toEqual({ count: 1, amountMinor: 952, orders: 1 });
    expect(figures.categories).toEqual([]);
    expect(figures.range).toEqual(DAY);
    expect(figures.comparison?.range).toEqual(BEFORE);
    expect(figures.comparison?.totals).toMatchObject({ grossMinor: 1000, taxMinor: 160, netMinor: 840, averageMinor: 1000, items: 1 });
  });

  it('takes the tax headline from the sum of tax rows, not orders.taxMinor', () => {
    const { totals } = storeSalesFigures(REPORT, null, DAY, BEFORE);
    expect(totals.taxMinor).toBe(621);
    expect(totals.taxMinor).toBe(REPORT.taxes.reduce((sum, row) => sum + row.taxMinor, 0));
    expect(totals.taxMinor).not.toBe(REPORT.orders.taxMinor);
  });

  it('maps byMethod to payment rows by order count, leaving out refund-only methods', () => {
    const { payments } = storeSalesFigures(REPORT, null, DAY, BEFORE);
    expect(payments.rows).toEqual([
      { method: 'card', label: '', amountMinor: 2569, orders: 2 },
      { method: 'cash', label: '', amountMinor: 1952, orders: 1 },
    ]);
    expect(payments.takenMinor).toBe(4521);
  });

  it('fills every day of the range, zero where the store had no sale', () => {
    const week = { from: '2026-11-16', to: '2026-11-20' };
    const report = { ...REPORT, byDay: [
      { day: '2026-11-17', orderCount: 1, salesMinor: 800, refundsMinor: 0 },
      { day: '2026-11-20', orderCount: 3, salesMinor: 4521, refundsMinor: 952 },
    ] };
    const { series } = storeSalesFigures(report, null, week, week);
    expect(series.map((point) => point.day)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    expect(series.map((point) => point.grossMinor)).toEqual([0, 800, 0, 0, 4521]);
    expect(series.map((point) => point.orderCount)).toEqual([0, 1, 0, 0, 3]);
  });
});

describe('storeHourly', () => {
  it('puts byHour into 24 bars for one day and its comparison, and none for a week', () => {
    const report = { ...REPORT, byHour: [...REPORT.byHour, { hour: '2026-11-21T09', orderCount: 1, salesMinor: 500, refundsMinor: 0 }] };
    const hourly = storeHourly(report, COMPARE, DAY, BEFORE, true)!;
    expect(hourly.hours).toHaveLength(24);
    expect(hourly.hours[9]).toBe(1952);
    expect(hourly.hours[14]).toBe(2569);
    expect(hourly.hours.filter((_, hour) => hour !== 9 && hour !== 14).every((value) => value === 0)).toBe(true);
    expect(hourly.compareHours).toHaveLength(24);
    expect(hourly.compareHours[9]).toBe(1000);
    expect(hourly.compareHours.reduce((sum, value) => sum + value, 0)).toBe(1000);
    expect(storeHourly(report, COMPARE, DAY, BEFORE, false)).toBeNull();
  });

  it('gives no comparison without a comparison report', () => {
    expect('comparison' in storeSalesFigures(REPORT, null, DAY, BEFORE)).toBe(false);
    expect(storeHourly(REPORT, null, DAY, BEFORE, true)!.compareHours).toEqual(Array(24).fill(0));
  });
});

describe('reportsView', () => {
  const STORE = storeSalesFigures(REPORT, COMPARE, DAY, BEFORE);
  const TILL_FIGURES = { ...STORE, totals: { ...STORE.totals, grossMinor: 999_999, medianMinor: 333_333, largestMinor: 666_666 } } as SalesFigures;
  const TILL_SPREAD: Spread = { current: { medianMinor: 333_333, largestMinor: 666_666 }, comparison: undefined };
  const TILL_OPTIONS = [{ value: 'all', label: 'All' }, { value: 'applied', label: 'Synced' }, { value: 'pending', label: 'Waiting to sync' }];
  const tillFn = () => vi.fn(() => ({ figures: TILL_FIGURES, hourly: null, spread: TILL_SPREAD }));

  it('store mode hides categories, the hero spread and the sync statuses, and never reads the till', () => {
    const till = tillFn();
    const hourly = storeHourly(REPORT, COMPARE, DAY, BEFORE, true);
    const view = reportsView({ status: 'ok', figures: STORE, hourly }, till, TILL_OPTIONS);
    expect(view.figures).toBe(STORE);
    expect(view.hourly).toBe(hourly);
    expect(till).not.toHaveBeenCalled();
    expect(view.storeWide).toBe(true);
    expect(view.hide).toEqual(['categories']);
    expect(view.statusOptions).toEqual([{ value: 'all', label: 'All' }]);
    expect(view.spread).toBeNull();
    expect(view.tillOnly).toBeNull();
    const text = JSON.stringify(view);
    for (const sentinel of ['999999', '333333', '666666']) expect(text).not.toContain(sentinel);
  });

  it('offline and failed answers show the till with This till only, offline', () => {
    for (const status of ['offline', 'error'] as const) {
      const view = reportsView({ status } as StoreSales, tillFn(), TILL_OPTIONS);
      expect(view.figures).toBe(TILL_FIGURES);
      expect(view.spread).toBe(TILL_SPREAD);
      expect(view.storeWide).toBe(false);
      expect(view.tillOnly).toBe('This till only, offline');
      expect(view.hide).toEqual([]);
      expect(view.statusOptions).toBe(TILL_OPTIONS);
    }
  });

  it('a 403 or a plugin without v2 shows the till with This till only', () => {
    for (const status of ['forbidden', 'unsupported', 'loading'] as const) {
      const view = reportsView({ status } as StoreSales, tillFn(), TILL_OPTIONS);
      expect(view.figures).toBe(TILL_FIGURES);
      expect(view.tillOnly).toBe('This till only');
      expect(view.hide).toEqual([]);
    }
  });
});

describe('whileFetching', () => {
  const ok: StoreSales = { status: 'ok', figures: storeSalesFigures(REPORT, COMPARE, DAY, BEFORE), hourly: null };

  it('keeps the store figures while the same query refreshes', () => {
    expect(whileFetching(ok, 'k', 'k')).toBe(ok);
  });

  it('drops the store figures when the query changes or never answered', () => {
    expect(whileFetching(ok, 'k', 'other')).toEqual({ status: 'loading' });
    expect(whileFetching(ok, null, 'k')).toEqual({ status: 'loading' });
    expect(whileFetching({ status: 'error' }, 'k', 'k')).toEqual({ status: 'loading' });
  });
});
