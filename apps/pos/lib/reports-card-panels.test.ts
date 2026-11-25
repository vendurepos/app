import type { Margin, SalesFigures } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { cardPanel, panelCsvFileName, panelScope } from './reports-card-panels';

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

it('opens a panel for payments, products, categories and taxes, and none for orders and refunds', () => {
  expect(cardPanel('payments')).toBe('payments');
  expect(cardPanel('products')).toBe('products');
  expect(cardPanel('categories')).toBe('categories');
  expect(cardPanel('taxes')).toBe('taxes');
  expect(cardPanel('orders')).toBeNull();
  expect(cardPanel('refunds')).toBeNull();
});

it("words the scope as Print summary's period, then this till's marker", () => {
  expect(panelScope(figures, null)).toBe('2026-11-17');
  const range = { ...figures, range: { from: '2026-11-17', to: '2026-11-18' } };
  expect(panelScope(range, 'This till only, offline')).toBe('2026-11-17 – 2026-11-18 · This till only, offline');
});

it("marks a till-only panel's CSV name, and leaves the store's and unknown names unchanged", () => {
  const name = 'sales-payments-2026-11-17-2026-11-17.csv';
  expect(panelCsvFileName('payments', name, null)).toBe(name);
  expect(panelCsvFileName('payments', name, 'This till only')).toBe('sales-payments-this-till-2026-11-17-2026-11-17.csv');
  expect(panelCsvFileName('payments', 'sales-taxes-2026-11-17-2026-11-17.csv', 'This till only')).toBe('sales-taxes-2026-11-17-2026-11-17.csv');
});
