import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { clampClosureScope, exportCsv, formatClosureDate, selectClosureRows, varianceText, type Closure } from '@tallyui/pos';
import { zReportLines } from './z-report';

export type ClosureHistoryRow = {
  id: string; number: number; closedAt: string; salesTotal: string; cashAtOpen: string; cashAtClose: string; variance: string;
};

// The keys are TallyUI exportCsv's label keys.
const CSV_LABELS: Record<string, string> = {
  'reports.csv_business_day': 'Business day', 'reports.csv_closure': 'Closure', 'reports.csv_register': 'Register',
  'reports.csv_store': 'Store', 'reports.csv_opened': 'Opened', 'reports.csv_closed': 'Closed', 'reports.csv_closer': 'Closed by',
  'register.unknown_cashier': 'Unknown cashier', 'reports.document.expected': 'Expected', 'register.counted': 'Counted',
  'register.variance': 'Variance', 'register.short': 'short', 'register.over': 'over', 'reports.exact': 'Exact',
  'reports.csv_status': 'Status', 'register.unsynced': 'Unsynced', 'reports.corrected': 'Corrected',
};

function listedClosures(rows: readonly Closure[], { registerId, storeKey, timezone, today }: {
  registerId: string; storeKey: string; timezone: string; today: string;
}): Closure[] {
  return selectClosureRows(rows, clampClosureScope({ from: '0000-01-01', to: today, registerId, storeKey }, today), timezone);
}

export function closureHistoryRows(rows: readonly Closure[], { registerId, storeKey, currency, timezone, today, blind }: {
  registerId: string; storeKey: string; currency: string; timezone: string; today: string; blind: boolean;
}): ClosureHistoryRow[] {
  const exponent = minorUnitDigits(currency);
  const words: Record<string, string> = { 'register.exact': 'Exact', 'register.short': 'short', 'register.over': 'over' };
  const cash = (amount: unknown) => blind || typeof amount !== 'number' ? '' : formatMoney({ amount, currency }) ?? '';
  return listedClosures(rows, { registerId, storeKey, timezone, today })
    .map((row) => ({
      id: row.id,
      number: row.number,
      closedAt: formatClosureDate(row.closed_at, { timezone, locale: 'en' }).datetime,
      salesTotal: blind ? '' : formatMoney({ amount: row.period_sales_total_minor, currency }) ?? '',
      cashAtOpen: cash((row.breakdowns.opening_float as { counted_minor?: unknown } | undefined)?.counted_minor),
      cashAtClose: cash(row.counted.cash),
      variance: !blind && typeof row.variance.cash === 'number'
        ? varianceText(row.variance.cash, exponent,
          (major) => formatMoney({ amount: Math.round(major * 10 ** exponent), currency }) ?? '', (key) => words[key]) : '',
    }));
}

/** v2's closures CSV (TallyUI exportCsv, WCPOS's own) of the closures this sheet lists, in English. */
export function closureHistoryCsv(rows: readonly Closure[], options: {
  registerId: string; storeKey: string; currency: string; timezone: string; today: string; store: string;
}): string {
  return exportCsv(listedClosures(rows, options), minorUnitDigits(options.currency), (key) => CSV_LABELS[key] ?? key, {}, options.store);
}

export function zCopyLines(closure: Closure, context: { store: string; currency: string; timezone: string; printedAt: string }): string[] {
  const [title, ...rest] = zReportLines(closure, context);
  return [title, `Copy · printed ${formatClosureDate(context.printedAt, { timezone: context.timezone, locale: 'en' }).datetime}`, ...rest];
}
