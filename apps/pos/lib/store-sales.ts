import type { SalesCardId, SalesOption } from '@tallyui/components';
import { daysOf, type DayRange, type SalesFigures } from '@tallyui/pos';
import type { SalesReport, SalesReportOutcome } from './sales-report';
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
  // categories: the report was v3 or later, so the Categories card has the store's figures (v2 has none, and hides it).
  | { status: 'ok'; figures: SalesFigures; hourly: Hourly | null; categories?: true };
type Report = SalesReport;
// v3 and later carry the median, largest and categories.
const fromV3 = (r: Report): r is Exclude<Report, { version: 2 }> => r.version >= 3;
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
 * orders.taxMinor. Median and largest come from v3 and later; v2 has no per-order totals, so they stay out and TallyUI hides them.
 * Rounding is v4's sales' cash rounding, inside gross, so net is gross − tax − rounding (SalesTotals.roundingMinor).
 */
function totals(r: Report): SalesFigures['totals'] {
  const grossMinor = r.orders.salesMinor;
  const taxMinor = r.taxes.reduce((sum, row) => sum + row.taxMinor, 0);
  const count = r.orders.count;
  // Below v4 the report has no rounding figure. A refund's returned rounding stays in refundsMinor, as TallyUI's local figures.
  const roundingMinor = r.version === 4 ? r.cashRounding.salesMinor : 0;
  // The plugin's report dates refunds by their own date.
  return {
    grossMinor, netMinor: grossMinor - taxMinor - roundingMinor, taxMinor, discountMinor: r.orders.discountsMinor,
    refundsMinor: r.refunds.totalMinor, embeddedRefundsMinor: 0, roundingMinor, refundBasis: 'dated',
    grossAfterRefundsMinor: grossMinor - r.refunds.totalMinor, orderCount: count,
    averageMinor: count > 0 ? Math.round(grossMinor / count) : 0, items: r.orders.itemCount, margin: NO_MARGIN,
    ...(fromV3(r) ? { medianMinor: r.orders.medianMinor, largestMinor: r.orders.largestMinor } : {}),
  };
}

// Products' and categories' rows alike: the line total with tax as net, no margin, best sellers first.
const groupRows = (rows: { key: string; name: string; quantity: number; salesMinor: number }[]) => rows
  .map((row) => ({ key: row.key, name: row.name, quantity: row.quantity, netMinor: row.salesMinor, margin: NO_MARGIN }))
  .sort((a, b) => b.netMinor - a.netMinor || b.quantity - a.quantity || a.name.localeCompare(b.name));

// Every day of the range, from the report's active days, zero where the store had no sale.
function series(r: Report, range: DayRange): SalesFigures['series'] {
  const byDay = new Map(r.byDay.map((row) => [row.day, row]));
  return daysOf(range).map((day) => {
    const row = byDay.get(day);
    return { day, grossMinor: row?.salesMinor ?? 0, orderCount: row?.orderCount ?? 0, refundsMinor: row?.refundsMinor ?? 0 };
  });
}

/** The sales report (and its comparison period's) as the SalesFigures the hero and cards read. Categories are v3's and later, else empty. */
export function storeSalesFigures(report: Report, compareReport: Report | null, range: DayRange, compare: DayRange): SalesFigures {
  // A refund-only method (orderCount 0) took no sale money, so it is not a payment row.
  const rows = report.byMethod.filter((row) => row.orderCount > 0)
    .map((row) => ({ method: row.method, label: '', amountMinor: row.salesMinor, orders: row.orderCount }))
    .sort((a, b) => b.amountMinor - a.amountMinor || codeUnit(a.method, b.method));
  const products = groupRows(report.products.map((row) => ({ ...row, key: row.productVariantId || row.sku || row.name })));
  const categories = fromV3(report) ? groupRows(report.categories.map((row) => ({ ...row, key: row.collectionId || row.name }))) : [];
  const taxes = report.taxes.map((row) => {
    const ratePpm = Math.round(row.ratePercent * PPM_PER_PERCENT);
    return { key: JSON.stringify([ratePpm, row.description]), ratePpm, label: row.description, taxMinor: row.taxMinor, netMinor: row.baseMinor };
  }).sort((a, b) => b.taxMinor - a.taxMinor || codeUnit(a.key, b.key));
  return {
    range, totals: totals(report),
    payments: { rows, takenMinor: rows.reduce((sum, row) => sum + (row.method === 'unpaid' ? 0 : row.amountMinor), 0) },
    products, categories, taxes,
    refunds: { count: report.refunds.count, amountMinor: report.refunds.totalMinor, orders: report.refunds.orderCount },
    series: series(report, range),
    ...(compareReport ? { comparison: { range: compare, totals: totals(compareReport), series: series(compareReport, compare) } } : {}),
  };
}

// One store day's 24 hourly sales, from the byHour rows dated that day.
function hoursOf(r: Report | null, day: string): number[] {
  const hours = Array<number>(HOURS).fill(0);
  for (const row of r?.byHour ?? []) if (row.hour.slice(0, 10) === day) hours[Number(row.hour.slice(11, 13))] += row.salesMinor;
  return hours;
}

/** The hero's by-hour bars for a one-day range and its comparison day; null for a longer range, which shows days. */
export function storeHourly(report: Report, compareReport: Report | null, range: DayRange, compare: DayRange, oneDay: boolean): Hourly | null {
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
    return { storeWide: true, figures: store.figures, hourly: store.hourly, spread: null, hide: store.categories ? [] : ['categories'], statusOptions: STORE_STATUS_OPTIONS, tillOnly: null };
  }
  const local = till();
  return {
    storeWide: false, figures: local.figures, hourly: local.hourly, spread: local.spread, hide: [], statusOptions: tillStatusOptions,
    tillOnly: store.status === 'offline' || store.status === 'error' ? TILL_ONLY_OFFLINE : TILL_ONLY,
  };
}

/** What Reports may show for the query `key`: store figures only if they answered this same query, else loading. */
export function shownStore(current: StoreSales, okKey: string | null, key: string): StoreSales {
  // Figures for another period, register or cashier never stay on screen; every other state passes through.
  return current.status === 'ok' && okKey !== key ? { status: 'loading' } : current;
}

/** The two report answers (the period's and its comparison's) as the Reports state; a report it cannot read is an error. */
export function storeAnswer(a: SalesReportOutcome, b: SalesReportOutcome, range: DayRange, compare: DayRange, oneDay: boolean): StoreSales {
  if (a.status === 'ok' && b.status === 'ok') {
    // fetchSalesReport accepts any JSON object, so a report missing a field throws here: that is a failed answer.
    try {
      return { status: 'ok', figures: storeSalesFigures(a.report, b.report, range, compare), hourly: storeHourly(a.report, b.report, range, compare, oneDay),
        ...(fromV3(a.report) ? { categories: true as const } : {}) };
    } catch {
      return { status: 'error' };
    }
  }
  const failed = (status: SalesReportOutcome['status']) => a.status === status || b.status === status;
  return { status: failed('forbidden') ? 'forbidden' : failed('unsupported') ? 'unsupported' : 'error' };
}
