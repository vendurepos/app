import { formatMoney } from '@tallyui/core';
import type { SalesFigures } from '@tallyui/pos';

/** The lines of v2's Reports "Print summary" for the shown period (CHECKLIST 8.1), plain text for printLines. */
export function salesSummaryLines(figures: SalesFigures, currency: string): string[] {
  const money = (minor: number) => formatMoney({ amount: minor, currency }) ?? '';
  const { range, totals, refunds, payments } = figures;
  const lines = [
    'Sales summary',
    range.from === range.to ? range.from : `${range.from} – ${range.to}`,
    `Total ${money(totals.grossMinor)}`,
    `Orders ${totals.orderCount}`,
    `Average order ${money(totals.averageMinor)}`,
    `Items ${totals.items}`,
    `Discounts ${money(totals.discountMinor)}`,
    `Tax ${money(totals.taxMinor)}`,
    `Refunds ${refunds.count} · ${money(refunds.amountMinor)}`,
  ];
  if (payments.rows.length > 0) {
    lines.push('Payments', ...payments.rows.map((row) => `${row.label || row.method} ${money(row.amountMinor)}`));
  }
  return lines;
}
