import { minorUnitDigits } from '@tallyui/core';
import { csvFromCells, minorToDecimal, type SalesFigures } from '@tallyui/pos';

/** The Sales room's figures as CSV rows (Section, Name, Quantity, Amount), amounts as plain decimals. */
export function salesCsv(figures: SalesFigures, currency: string): string {
  const digits = minorUnitDigits(currency);
  const amount = (minor: number) => minorToDecimal(minor, digits);
  const { totals, refunds } = figures;
  return csvFromCells([
    ['Section', 'Name', 'Quantity', 'Amount'],
    ['Summary', 'Total', '', amount(totals.grossMinor)],
    ['Summary', 'Net sales', '', amount(totals.netMinor)],
    ['Summary', 'Orders', totals.orderCount, ''],
    ['Summary', 'Average order', '', amount(totals.averageMinor)],
    ['Summary', 'Items', totals.items, ''],
    ['Summary', 'Discounts', '', amount(totals.discountMinor)],
    ['Summary', 'Tax', '', amount(totals.taxMinor)],
    ['Summary', 'Refunds', refunds.count, amount(refunds.amountMinor)],
    ...figures.payments.rows.map((row) => ['Payments', row.label || row.method, row.orders, amount(row.amountMinor)]),
    ...figures.products.map((row) => ['Products', row.name, row.quantity, amount(row.netMinor)]),
    ...figures.categories.map((row) => ['Categories', row.name, row.quantity, amount(row.netMinor)]),
    ...figures.taxes.map((row) => ['Taxes', row.label, '', amount(row.taxMinor)]),
  ]);
}

/** v2's `sales-<report>-<from>-<to>.csv`; the till's report is the summary. */
export function salesCsvFileName(figures: SalesFigures): string {
  return `sales-summary-${figures.range.from}-${figures.range.to}.csv`;
}
