import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { clampClosureScope, exportCsv, formatClosureDate, selectClosureRows, varianceText, type Closure } from '@tallyui/pos';
import { fetchRegisters, OWN_REGISTER_LABEL, registerLabel } from './register-choice';
import { sessionContext, type Session } from './session';
import { zReportLines } from './z-report';

export type ClosureHistoryRow = {
  id: string; registerId: string; register: string; number: number; closedAt: string; salesTotal: string; cashAtOpen: string; cashAtClose: string; variance: string;
};

/** One closure of the plugin's GET /tally/v1/registers/:id (packages/vendure-plugin/src/api/registers.controller.ts). */
export type TallyClosureRead = {
  closureId: string; sessionId: string; registerId: string; number: number; businessDay: string | null; openedAt: string; closedAt: string;
  closedBy: string | null; approvedBy: string | null; tillExpected: Record<string, number>; counted: Record<string, number>;
  expected: Record<string, number>; variance: Record<string, number>; periodSalesTotalMinor: number; periodRefundsTotalMinor: number;
  perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number; unsyncedCount: number; unsyncedTotalMinor: number;
  softwareVersion: string; orderIds: string[]; movementIds: string[]; receivedAt: string;
};

/** A server closure as TallyUI's Closure: no breakdowns (the read has none, so no cash at open) and no print state. */
export function closureFromRead(read: TallyClosureRead, storeKey: string): Closure {
  return {
    id: read.closureId, server_closure_id: read.closureId, session_id: read.sessionId, register_id: read.registerId, store_key: storeKey,
    business_day: read.businessDay ?? '', closed_by: read.closedBy, number: read.number, opened_at: read.openedAt, closed_at: read.closedAt,
    till_expected: read.tillExpected, expected: read.expected, counted: read.counted, variance: read.variance,
    period_sales_total_minor: read.periodSalesTotalMinor, period_refunds_total_minor: read.periodRefundsTotalMinor,
    perpetual_sales_total_minor: read.perpetualSalesTotalMinor, perpetual_refunds_total_minor: read.perpetualRefundsTotalMinor,
    unsynced_count: read.unsyncedCount, unsynced_total_minor: read.unsyncedTotalMinor, software_version: read.softwareVersion, breakdowns: {},
    order_ids: read.orderIds, movement_ids: read.movementIds, printed_at: null, print_count: 0, number_retried: false, corrections_count: 0,
  };
}

/** The local closures, then each server closure this till does not hold: the local copy keeps its breakdowns and print state. */
export function mergeClosures(local: readonly Closure[], remote: readonly Closure[]): Closure[] {
  const held = new Set(local.flatMap((row) => [row.id, row.server_closure_id]));
  return [...local, ...remote.filter((row) => !held.has(row.id))];
}

/** Every listed register's closures (one page of 100 each: the 92-day window at one a day) and each register's label. */
export async function fetchChannelClosures(session: Session, storeKey: string): Promise<{ closures: Closure[]; names: Record<string, string> }> {
  const listed = await fetchRegisters(session);
  const pages = await Promise.all(listed.map(async ({ id }) => {
    const response = await fetch(`${session.url}/tally/v1/registers/${encodeURIComponent(id)}?take=100`, { headers: sessionContext(session).headers });
    if (!response.ok) throw new Error(`GET /tally/v1/registers/${id} answered ${response.status}`);
    const body: { closures: { items: TallyClosureRead[] } } = await response.json();
    return body.closures.items.map((read) => closureFromRead(read, storeKey));
  }));
  return { closures: pages.flat(), names: Object.fromEntries(listed.map((register) => [register.id, registerLabel(register)])) };
}

// The keys are TallyUI exportCsv's label keys.
const CSV_LABELS: Record<string, string> = {
  'reports.csv_business_day': 'Business day', 'reports.csv_closure': 'Closure', 'reports.csv_register': 'Register',
  'reports.csv_store': 'Store', 'reports.csv_opened': 'Opened', 'reports.csv_closed': 'Closed', 'reports.csv_closer': 'Closed by',
  'register.unknown_cashier': 'Unknown cashier', 'reports.document.expected': 'Expected', 'register.counted': 'Counted',
  'register.variance': 'Variance', 'register.short': 'short', 'register.over': 'over', 'reports.exact': 'Exact',
  'reports.csv_status': 'Status', 'register.unsynced': 'Unsynced', 'reports.corrected': 'Corrected',
};

function listedClosures(rows: readonly Closure[], { storeKey, timezone, today }: { storeKey: string; timezone: string; today: string }): Closure[] {
  return selectClosureRows(rows, clampClosureScope({ from: '0000-01-01', to: today, registerId: '', storeKey }, today), timezone);
}

export function closureHistoryRows(rows: readonly Closure[], { ownRegisterId, names, storeKey, currency, timezone, today, blind }: {
  ownRegisterId: string; names: Record<string, string>; storeKey: string; currency: string; timezone: string; today: string; blind: boolean;
}): ClosureHistoryRow[] {
  const exponent = minorUnitDigits(currency);
  const words: Record<string, string> = { 'register.exact': 'Exact', 'register.short': 'short', 'register.over': 'over' };
  const cash = (amount: unknown) => blind || typeof amount !== 'number' ? '' : formatMoney({ amount, currency }) ?? '';
  return listedClosures(rows, { storeKey, timezone, today })
    .map((row) => ({
      id: row.id,
      registerId: row.register_id,
      register: row.register_id === ownRegisterId ? OWN_REGISTER_LABEL : names[row.register_id] ?? `Register ${row.register_id.slice(0, 8)}`,
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
  ownRegisterId: string; names: Record<string, string>; storeKey: string; currency: string; timezone: string; today: string; store: string;
}): string {
  return exportCsv(listedClosures(rows, options), minorUnitDigits(options.currency), (key) => CSV_LABELS[key] ?? key,
    { ...options.names, [options.ownRegisterId]: OWN_REGISTER_LABEL }, options.store);
}

/** The closures CSV's file name: the listed closures' oldest to newest close date in the store's zone; today's when none. */
export function closureCsvFileName(rows: readonly Closure[], options: { storeKey: string; timezone: string; today: string }): string {
  const days = listedClosures(rows, options).map((row) => formatClosureDate(row.closed_at, { timezone: options.timezone, locale: 'en' }).date_ymd).sort();
  if (days.length === 0) return `closures-${options.today}.csv`;
  return `closures-${days[0]}-to-${days[days.length - 1]}.csv`;
}

export function zCopyLines(closure: Closure, context: { store: string; currency: string; timezone: string; printedAt: string }): string[] {
  const [title, ...rest] = zReportLines(closure, context);
  return [title, `Copy · printed ${formatClosureDate(context.printedAt, { timezone: context.timezone, locale: 'en' }).datetime}`, ...rest];
}
