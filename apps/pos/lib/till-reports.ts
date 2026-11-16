import type { SalesFilters, SalesOption } from '@tallyui/components';
import {
  comparisonRange, presetRange, reportOrderFromPosOrder, reportRefundFromPosRefund, salesFigures,
  type PosOrder, type PosRefund, type SalesFigures,
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

export function tillSalesFigures({ orders, refunds, filters, timezone }: {
  orders: readonly PosOrder[]; refunds: readonly PosRefund[]; filters: SalesFilters; timezone: string;
}): SalesFigures {
  const kept = orders.filter((order) => order.syncStatus !== 'rejected'
    && (filters.status === 'all' || order.syncStatus === filters.status)
    && (!filters.cashierId || order.cashierRef === filters.cashierId)
    && (!filters.registerId || order.registerId === filters.registerId));
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
