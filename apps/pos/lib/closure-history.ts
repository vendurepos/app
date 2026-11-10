import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { clampClosureScope, formatClosureDate, selectClosureRows, varianceText, type Closure } from '@tallyui/pos';
import { zReportLines } from './z-report';

export type ClosureHistoryRow = { id: string; number: number; closedAt: string; salesTotal: string; variance: string };

export function closureHistoryRows(rows: readonly Closure[], { registerId, storeKey, currency, timezone, today, blind }: {
  registerId: string; storeKey: string; currency: string; timezone: string; today: string; blind: boolean;
}): ClosureHistoryRow[] {
  const exponent = minorUnitDigits(currency);
  const words: Record<string, string> = { 'register.exact': 'Exact', 'register.short': 'short', 'register.over': 'over' };
  return selectClosureRows(rows, clampClosureScope({ from: '0000-01-01', to: today, registerId, storeKey }, today), timezone)
    .map((row) => ({
      id: row.id,
      number: row.number,
      closedAt: formatClosureDate(row.closed_at, { timezone, locale: 'en' }).datetime,
      salesTotal: blind ? '' : formatMoney({ amount: row.period_sales_total_minor, currency }) ?? '',
      variance: !blind && typeof row.variance.cash === 'number'
        ? varianceText(row.variance.cash, exponent,
          (major) => formatMoney({ amount: Math.round(major * 10 ** exponent), currency }) ?? '', (key) => words[key]) : '',
    }));
}

export function zCopyLines(closure: Closure, context: { store: string; currency: string; timezone: string; printedAt: string }): string[] {
  const [title, ...rest] = zReportLines(closure, context);
  return [title, `Copy · printed ${formatClosureDate(context.printedAt, { timezone: context.timezone, locale: 'en' }).datetime}`, ...rest];
}
