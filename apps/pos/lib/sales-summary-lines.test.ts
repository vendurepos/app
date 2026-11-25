import type { Margin, SalesFigures } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { salesSummaryLines } from './sales-summary-lines';

const margin: Margin = { costedNetMinor: 0, costMinor: 0, profitMinor: 0, marginPct: null, missingLines: 0, missingQuantity: 0 };
const figures: SalesFigures = {
  range: { from: '2026-11-17', to: '2026-11-17' },
  totals: {
    grossMinor: 952, netMinor: 800, taxMinor: 152, discountMinor: 80, refundsMinor: 0, embeddedRefundsMinor: 0,
    roundingMinor: 0, refundBasis: 'dated', grossAfterRefundsMinor: 952,
    orderCount: 1, averageMinor: 952, items: 1, margin,
  },
  payments: { rows: [{ method: 'cash', label: 'Cash', amountMinor: 952, orders: 1 }], takenMinor: 952 },
  products: [], categories: [], taxes: [],
  refunds: { count: 0, amountMinor: 0, orders: 0 },
  series: [],
};

it("prints one day's summary with its payments", () => {
  expect(salesSummaryLines(figures, 'EUR')).toEqual([
    'Sales summary', '2026-11-17', 'Total €9.52', 'Orders 1', 'Average order €9.52', 'Items 1', 'Discounts €0.80',
    'Tax €1.52', 'Refunds 0 · €0.00', 'Payments', 'Cash €9.52',
  ]);
});

it('prints a range of days as from – to', () => {
  const lines = salesSummaryLines({ ...figures, range: { from: '2026-11-10', to: '2026-11-17' } }, 'EUR');
  expect(lines[1]).toBe('2026-11-10 – 2026-11-17');
});

it('leaves out Payments with no rows, and prints the method for an empty label', () => {
  const none = salesSummaryLines({ ...figures, payments: { rows: [], takenMinor: 0 } }, 'EUR');
  expect(none).not.toContain('Payments');
  const unlabelled = { method: 'card', label: '', amountMinor: 952, orders: 1 };
  const lines = salesSummaryLines({ ...figures, payments: { rows: [unlabelled], takenMinor: 952 } }, 'EUR');
  expect(lines.slice(-2)).toEqual(['Payments', 'card €9.52']);
});

it('marks a till-only summary on the line after the title', () => {
  const lines = salesSummaryLines(figures, 'EUR', 'This till only, offline');
  expect(lines.slice(0, 3)).toEqual(['Sales summary', 'This till only, offline', '2026-11-17']);
});
