import type { Margin, SalesFigures } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { salesCsv, salesCsvFileName } from './sales-csv';

const margin: Margin = { costedNetMinor: 0, costMinor: 0, profitMinor: 0, marginPct: null, missingLines: 0, missingQuantity: 0 };
const figures: SalesFigures = {
  range: { from: '2026-11-18', to: '2026-11-19' },
  totals: {
    grossMinor: 1904, netMinor: 1600, taxMinor: 304, discountMinor: 80, refundsMinor: 0, embeddedRefundsMinor: 0,
    roundingMinor: 0, refundBasis: 'dated', grossAfterRefundsMinor: 1904,
    orderCount: 2, averageMinor: 952, items: 3, margin,
  },
  payments: { rows: [{ method: 'cash', label: 'Cash', amountMinor: 1904, orders: 2 }], takenMinor: 1904 },
  products: [{ key: 'mug', name: 'Tally "Fixture" Mug', quantity: 3, netMinor: 1600, margin }],
  categories: [{ key: 'kitchen', name: 'Kitchen', quantity: 3, netMinor: 1600, margin }],
  taxes: [{ key: 'std', ratePpm: 190000, label: 'VAT 19%', taxMinor: 304, netMinor: 1600 }],
  refunds: { count: 1, amountMinor: 952, orders: 1 },
  series: [],
};

it('writes the summary, payments, products, categories and taxes as plain decimals', () => {
  expect(salesCsv(figures, 'EUR')).toBe([
    '"Section","Name","Quantity","Amount"',
    '"Summary","Total","","19.04"',
    '"Summary","Net sales","","16.00"',
    '"Summary","Orders","2",""',
    '"Summary","Average order","","9.52"',
    '"Summary","Items","3",""',
    '"Summary","Discounts","","0.80"',
    '"Summary","Tax","","3.04"',
    '"Summary","Refunds","1","9.52"',
    '"Payments","Cash","2","19.04"',
    '"Products","Tally ""Fixture"" Mug","3","16.00"',
    '"Categories","Kitchen","3","16.00"',
    '"Taxes","VAT 19%","","3.04"',
  ].join('\r\n'));
});

it('names the file sales-summary-<from>-<to>.csv', () => {
  expect(salesCsvFileName(figures)).toBe('sales-summary-2026-11-18-2026-11-19.csv');
});

it('writes a zero-decimal currency without a fraction', () => {
  const yen = { ...figures, totals: { ...figures.totals, grossMinor: 1200 } };
  expect(salesCsv(yen, 'JPY').split('\r\n')[1]).toBe('"Summary","Total","","1200"');
});

it('marks a till-only export with a Scope row after the header', () => {
  const marked = salesCsv(figures, 'EUR', 'This till only').split('\r\n');
  expect(marked[1]).toBe('"Scope","This till only","",""');
  expect(marked.filter((_, i) => i !== 1)).toEqual(salesCsv(figures, 'EUR').split('\r\n'));
});

it('names a till-only file sales-summary-this-till-<from>-<to>.csv', () => {
  expect(salesCsvFileName(figures, 'This till only')).toBe('sales-summary-this-till-2026-11-18-2026-11-19.csv');
});
