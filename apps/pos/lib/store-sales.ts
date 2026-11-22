import type { SalesCardId, SalesOption } from '@tallyui/components';
import { daysOf, type DayRange, type SalesFigures } from '@tallyui/pos';
import type { SalesReportV2 } from './sales-report';
import type { OrderSpread } from './till-reports';

export type Hourly = { hours: number[]; compareHours: number[] };
export type Spread = { current: OrderSpread; comparison: OrderSpread | undefined };
// The v2 route has no sync status: every store order is on the server.
export const STORE_STATUS_OPTIONS: SalesOption[] = [{ value: 'all', label: 'All' }];
// Front desk ruling 3 (8.1f): the line over this till's own figures when the store's are not shown.
export const TILL_ONLY = 'This till only';
export const TILL_ONLY_OFFLINE = 'This till only, offline';
export type StoreSales =
  | { status: 'loading' | 'offline' | 'forbidden' | 'unsupported' | 'error' }
  | { status: 'ok'; figures: SalesFigures; hourly: Hourly | null };
export type ReportsView = {
  storeWide: boolean; figures: SalesFigures; hourly: Hourly | null; spread: Spread | null;
  hide: SalesCardId[]; statusOptions: SalesOption[]; tillOnly: string | null;
};

// The route carries no cost prices, so the store's margin is unknown, as the local figures' margin with nothing costed.
export const NO_MARGIN: SalesFigures['totals']['margin'] = { costedNetMinor: 0, costMinor: 0, profitMinor: 0, marginPct: null, missingLines: 0, missingQuantity: 0 };
// Hours in a store day's bar chart.
const HOURS = 24;
// Vendure's tax rate is a percentage; TaxRow.ratePpm is parts per million.
const PPM_PER_PERCENT = 10_000;
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The report's totals on salesFigures' basis. The tax headline is the sum of the tax rows (the #289 ruling), never
 * orders.taxMinor. Median and largest are left out: the route has no per-order totals, and no till figure fills them.
 */
function totals(r: SalesReportV2): SalesFigures['totals'] {
  const grossMinor = r.orders.salesMinor;
  const taxMinor = r.taxes.reduce((sum, row) => sum + row.taxMinor, 0);
  const count = r.orders.count;
  return {
    grossMinor, netMinor: grossMinor - taxMinor, taxMinor, discountMinor: r.orders.discountsMinor,
    refundsMinor: r.refunds.totalMinor, embeddedRefundsMinor: 0, orderCount: count,
    averageMinor: count > 0 ? Math.round(grossMinor / count) : 0, items: r.orders.itemCount, margin: NO_MARGIN,
  };
}

// Every day of the range, from the report's active days, zero where the store had no sale.
function series(r: SalesReportV2, range: DayRange): SalesFigures['series'] {
  const byDay = new Map(r.byDay.map((row) => [row.day, row]));
  return daysOf(range).map((day) => {
    const row = byDay.get(day);
    return { day, grossMinor: row?.salesMinor ?? 0, orderCount: row?.orderCount ?? 0, refundsMinor: row?.refundsMinor ?? 0 };
  });
}

/** The v2 sales report (and its comparison period's) as the SalesFigures the hero and cards read. Categories stay empty. */
export function storeSalesFigures(report: SalesReportV2, compareReport: SalesReportV2 | null, range: DayRange, compare: DayRange): SalesFigures {
  // A refund-only method (orderCount 0) took no sale money, so it is not a payment row.
  const rows = report.byMethod.filter((row) => row.orderCount > 0)
    .map((row) => ({ method: row.method, label: '', amountMinor: row.salesMinor, orders: row.orderCount }))
    .sort((a, b) => b.amountMinor - a.amountMinor || codeUnit(a.method, b.method));
  const products = report.products
    .map((row) => ({ key: row.productVariantId || row.sku || row.name, name: row.name, quantity: row.quantity, netMinor: row.salesMinor, margin: NO_MARGIN }))
    .sort((a, b) => b.netMinor - a.netMinor || b.quantity - a.quantity || a.name.localeCompare(b.name));
  const taxes = report.taxes.map((row) => {
    const ratePpm = Math.round(row.ratePercent * PPM_PER_PERCENT);
    return { key: JSON.stringify([ratePpm, row.description]), ratePpm, label: row.description, taxMinor: row.taxMinor, netMinor: row.baseMinor };
  }).sort((a, b) => b.taxMinor - a.taxMinor || codeUnit(a.key, b.key));
  return {
    range, totals: totals(report),
    payments: { rows, takenMinor: rows.reduce((sum, row) => sum + (row.method === 'unpaid' ? 0 : row.amountMinor), 0) },
    products, categories: [], taxes,
    refunds: { count: report.refunds.count, amountMinor: report.refunds.totalMinor, orders: report.refunds.orderCount },
    series: series(report, range),
    ...(compareReport ? { comparison: { range: compare, totals: totals(compareReport), series: series(compareReport, compare) } } : {}),
  };
}

// One store day's 24 hourly sales, from the byHour rows dated that day.
function hoursOf(r: SalesReportV2 | null, day: string): number[] {
  const hours = Array<number>(HOURS).fill(0);
  for (const row of r?.byHour ?? []) if (row.hour.slice(0, 10) === day) hours[Number(row.hour.slice(11, 13))] += row.salesMinor;
  return hours;
}

/** The hero's by-hour bars for a one-day range and its comparison day; null for a longer range, which shows days. */
export function storeHourly(report: SalesReportV2, compareReport: SalesReportV2 | null, range: DayRange, compare: DayRange, oneDay: boolean): Hourly | null {
  if (!oneDay) return null;
  return { hours: hoursOf(report, range.from), compareHours: hoursOf(compareReport, compare.from) };
}

/**
 * What Reports shows (Front desk rulings 2026-11-17): the store's figures when they came, else this till's own under a
 * line that says so. The two are never mixed: the store view never calls `till`.
 */
export function reportsView(
  store: StoreSales,
  till: () => { figures: SalesFigures; hourly: Hourly | null; spread: Spread },
  tillStatusOptions: SalesOption[],
): ReportsView {
  if (store.status === 'ok') {
    return { storeWide: true, figures: store.figures, hourly: store.hourly, spread: null, hide: ['categories'], statusOptions: STORE_STATUS_OPTIONS, tillOnly: null };
  }
  const local = till();
  return {
    storeWide: false, figures: local.figures, hourly: local.hourly, spread: local.spread, hide: [], statusOptions: tillStatusOptions,
    tillOnly: store.status === 'offline' || store.status === 'error' ? TILL_ONLY_OFFLINE : TILL_ONLY,
  };
}

/** The state while the query `key` is fetching: the last store figures if they answered this same query, else loading. */
export function whileFetching(current: StoreSales, okKey: string | null, key: string): StoreSales {
  // Only a refresh of the same query keeps them: figures for another period, register or cashier never stay on screen.
  return current.status === 'ok' && okKey === key ? current : { status: 'loading' };
}
