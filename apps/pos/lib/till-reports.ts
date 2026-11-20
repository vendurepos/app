import type { SalesFilters, SalesOption } from '@tallyui/components';
import {
  comparisonRange, daysOf, inRange, presetRange, reportOrderFromPosOrder, reportRefundFromPosRefund, salesFigures,
  type PosOrder, type PosRefund, type ReportOrder, type SalesFigures, type StoreDay,
} from '@tallyui/pos';

// The labels are the Orders panel's sync words.
export const REPORT_STATUS_OPTIONS: SalesOption[] = [
  { value: 'all', label: 'All' },
  { value: 'applied', label: 'Synced' },
  { value: 'pending', label: 'Waiting to sync' },
];

export function initialSalesFilters(now: Date, timezone: string): SalesFilters {
  return { preset: 'today', range: presetRange('today', now, timezone), compare: 'previous', status: 'all', cashierId: null, registerId: null };
}

export function reportOptions(orders: readonly PosOrder[]): { cashierOptions: SalesOption[]; registerOptions: SalesOption[] } {
  const cashiers = new Set<string>();
  const registers = new Set<string>();
  for (const order of orders) {
    if (order.syncStatus === 'rejected') continue;
    if (order.cashierRef) cashiers.add(order.cashierRef);
    if (order.registerId) registers.add(order.registerId);
  }
  return {
    cashierOptions: [{ value: '', label: 'All' }, ...[...cashiers].sort().map((value) => ({ value, label: value }))],
    registerOptions: [{ value: '', label: 'All' }, ...[...registers].sort().map((value) => ({ value, label: value }))],
  };
}

export function keptTillOrders(orders: readonly PosOrder[], filters: SalesFilters): PosOrder[] {
  return orders.filter((order) => order.syncStatus !== 'rejected'
    && (filters.status === 'all' || order.syncStatus === filters.status)
    && (!filters.cashierId || order.cashierRef === filters.cashierId)
    && (!filters.registerId || order.registerId === filters.registerId));
}

export function isOneDay(filters: SalesFilters): boolean {
  return filters.preset === 'today' || filters.preset === 'yesterday' || (filters.preset === 'custom' && filters.range.from === filters.range.to);
}

// The by-hour counterpart of the daily series' gross, from the same orders' totalMinor.
export function hourlyGross(orders: readonly ReportOrder[], day: StoreDay, timezone: string): number[] {
  const hours = Array<number>(24).fill(0);
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timezone === 'device' ? undefined : timezone, hour: '2-digit', hourCycle: 'h23' });
  for (const order of orders) {
    if (inRange(order.at, { from: day, to: day }, timezone)) hours[Number(hour.format(new Date(order.at)))] += order.totalMinor;
  }
  return hours;
}

export function tillHourly({ orders, filters, timezone }: {
  orders: readonly PosOrder[]; filters: SalesFilters; timezone: string;
}): { hours: number[]; compareHours: number[] } | null {
  if (!isOneDay(filters)) return null;
  const kept = keptTillOrders(orders, filters).map((order) => reportOrderFromPosOrder(order));
  const compare = comparisonRange(filters.range, filters.compare, filters.preset === 'custom' ? undefined : filters.preset);
  return { hours: hourlyGross(kept, filters.range.from, timezone), compareHours: hourlyGross(kept, compare.from, timezone) };
}

export function compareLabel(filters: SalesFilters): string {
  const days = filters.preset === 'custom' ? daysOf(filters.range).length : 0;
  if (filters.preset === 'thisWeek' || filters.preset === 'lastWeek' || (days > 1 && days <= 7)) return 'vs the week before';
  if (filters.preset === 'thisMonth' || filters.preset === 'lastMonth' || days > 7) return 'vs the month before';
  if (filters.compare === 'previous') return 'vs yesterday';
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${filters.range.from}T00:00:00Z`));
  return `vs last ${weekday}`;
}

export function tillSalesFigures({ orders, refunds, filters, timezone }: {
  orders: readonly PosOrder[]; refunds: readonly PosRefund[]; filters: SalesFilters; timezone: string;
}): SalesFigures {
  const kept = keptTillOrders(orders, filters);
  const keptIds = new Set(kept.map((order) => order.id));
  const keptRefunds = refunds.flatMap((refund) => {
    const report = reportRefundFromPosRefund(refund);
    if (!report) return [];
    if (filters.registerId && refund.registerId !== filters.registerId) return [];
    if ((filters.cashierId || filters.status !== 'all') && !keptIds.has(refund.orderId)) return [];
    return [report];
  });
  const compare = comparisonRange(filters.range, filters.compare, filters.preset === 'custom' ? undefined : filters.preset);
  return salesFigures({ orders: kept.map((order) => reportOrderFromPosOrder(order)), refunds: keptRefunds, range: filters.range, compare, timezone });
}

/** The signed-in cashier's own sales today (CHECKLIST 6.1): the Reports hero's figure for Today with that cashier picked. */
export function cashierSalesToday({ orders, refunds, cashierRef, now, timezone }: {
  orders: readonly PosOrder[]; refunds: readonly PosRefund[]; cashierRef: string; now: Date; timezone: string;
}): number {
  return tillSalesFigures({ orders, refunds, filters: { ...initialSalesFilters(now, timezone), cashierId: cashierRef }, timezone }).totals.grossMinor;
}

export type OrderSpread = { medianMinor: number; largestMinor: number };

function spread(totals: number[]): OrderSpread {
  const sorted = [...totals].sort((a, b) => a - b);
  if (sorted.length === 0) return { medianMinor: 0, largestMinor: 0 };
  const mid = Math.floor(sorted.length / 2);
  const medianMinor = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { medianMinor, largestMinor: sorted[sorted.length - 1] };
}

/** The median and largest order total in the range and in its comparison range, on salesFigures' basis (each order's totalMinor). */
export function tillOrderSpread({ orders, filters, timezone }: {
  orders: readonly PosOrder[]; filters: SalesFilters; timezone: string;
}): { current: OrderSpread; comparison: OrderSpread | undefined } {
  const kept = keptTillOrders(orders, filters).map((order) => reportOrderFromPosOrder(order));
  const compare = comparisonRange(filters.range, filters.compare, filters.preset === 'custom' ? undefined : filters.preset);
  const current = kept.filter((order) => inRange(order.at, filters.range, timezone)).map((order) => order.totalMinor);
  const before = kept.filter((order) => inRange(order.at, compare, timezone)).map((order) => order.totalMinor);
  return { current: spread(current), comparison: before.length > 0 ? spread(before) : undefined };
}

/** The hero's "Running total" (v2 10-reports): each value is the sum of it and every value before it. */
export function runningTotal(values: readonly number[]): number[] {
  let sum = 0;
  return values.map((value) => (sum += value));
}
