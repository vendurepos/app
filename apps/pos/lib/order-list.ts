import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderHistoryRow, OrderStatus } from '@tallyui/components';
import type { OrderFilterField } from '@tallyui/core';
import { listVendureOrderDetails, type VendureOrder, type VendureOrderListOptions } from '@tallyui/connector-vendure';
import { orderFiltersQuery, type OrderFilterValue, type StoreDay } from '@tallyui/pos';
import { orderHistoryNotice, orderStateLabel, toOrderHistoryRow, type OrderHistoryNotice } from './order-history';
import { toOrderStatus } from './order-detail';
import { sessionContext, type Session } from './session';
import { tenderName } from './z-report';

// v2's table shows 20–25 rows before "load more"; Vendure allows up to 100.
export const ORDER_PAGE_SIZE = 25;
// Wait for typing to pause so each key press is not a request.
export const ORDER_SEARCH_DEBOUNCE_MS = 300;
// These are what listVendureOrders can filter by. Payment method, store and created-via
// are unsupported, so the screen shows no pill for them.
export const VENDURE_ORDER_FILTER_FIELDS: readonly OrderFilterField[] = ['status', 'customerId', 'cashierId', 'registerId', 'dateRange'];
export const ORDER_STATUS_OPTIONS: { value: string; label: string }[] = [
  'PaymentAuthorized', 'PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered', 'Cancelled',
].map(value => ({ value, label: orderStateLabel(value) }));
export type OrderListQuery = { search: string; filters: OrderFilterValue };
export type OrderTableRow = {
  id: string; code: string; stateLabel: string; status: OrderStatus; placedAt: string; day: StoreDay;
  customer: string | null; cashierRef: string | null; paymentMethods: string;
  totalMinor: number; currency: string; history: OrderHistoryRow;
};

export function orderListOptions(query: OrderListQuery, timezone: string, skip: number): VendureOrderListOptions {
  const { filters, search } = query;
  const { dateRange } = orderFiltersQuery(filters, timezone);
  return { skip, take: ORDER_PAGE_SIZE,
    ...(filters.status !== undefined ? { state: [filters.status] } : {}),
    ...(filters.customerId !== undefined ? { customerId: filters.customerId } : {}),
    ...(filters.cashierId !== undefined ? { tallyCashierRef: filters.cashierId } : {}),
    ...(filters.registerId !== undefined ? { tallyRegisterId: filters.registerId } : {}),
    ...(dateRange ? { orderPlacedAt: dateRange } : {}), ...(search.trim() ? { search: search.trim() } : {}),
  };
}
export function storeDayOf(iso: string, timezone: string): StoreDay {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone === 'device' ? undefined : timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
/** A payment's tender in words: the till's metadata.tender.method when set, else Vendure's payment method. */
export function paymentTenderName(payment: { method: string; metadata?: unknown }): string {
  const method = (payment.metadata as { tender?: { method?: unknown } } | null)?.tender?.method;
  return tenderName(typeof method === 'string' && method.length > 0 ? method : payment.method);
}
export function toOrderTableRow(order: VendureOrder, timezone: string): OrderTableRow {
  const placedAt = order.orderPlacedAt ?? order.updatedAt;
  const payments = (order.payments ?? []).filter(payment => !['Declined', 'Error', 'Cancelled'].includes(payment.state)).map(paymentTenderName);
  return { id: order.id, code: order.code, stateLabel: orderStateLabel(order.state), status: toOrderStatus(order.state),
    placedAt, day: storeDayOf(placedAt, timezone),
    customer: order.customer ? `${order.customer.firstName} ${order.customer.lastName}`.trim() || order.customer.emailAddress : null,
    cashierRef: order.customFields?.tallyCashierRef ?? null, paymentMethods: [...new Set(payments)].join(', '),
    totalMinor: order.totalWithTax, currency: order.currencyCode, history: toOrderHistoryRow(order),
  };
}
export function groupOrdersByDay(rows: readonly OrderTableRow[], today: StoreDay): { day: StoreDay; label: string; rows: OrderTableRow[] }[] {
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const groups: { day: StoreDay; label: string; rows: OrderTableRow[] }[] = [];
  for (const row of rows) {
    if (groups.at(-1)?.day !== row.day) {
      const label = row.day === today ? 'Today' : row.day === yesterday.toISOString().slice(0, 10) ? 'Yesterday'
        : new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
          .format(new Date(`${row.day}T00:00:00Z`));
      groups.push({ day: row.day, label, rows: [] });
    }
    groups.at(-1)!.rows.push(row);
  }
  return groups;
}
export async function loadOrderPage(session: Session, query: OrderListQuery, timezone: string, skip: number): Promise<{ orders: VendureOrder[]; totalItems: number } | { notice: OrderHistoryNotice }> {
  try {
    const { items, totalItems } = await listVendureOrderDetails(sessionContext(session), orderListOptions(query, timezone, skip));
    return { orders: items, totalItems };
  } catch (error) { return { notice: orderHistoryNotice(error) }; }
}

export function useOrderList(session: Session, open: boolean, query: OrderListQuery, timezone: string): {
  orders: VendureOrder[]; totalItems: number; notice: OrderHistoryNotice | null; loading: boolean; loadMore(): void; reload(): void;
} {
  const [orders, setOrders] = useState<VendureOrder[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [notice, setNotice] = useState<OrderHistoryNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const counter = useRef(0), previous = useRef<unknown[]>([]);
  const filters = JSON.stringify(query.filters), search = query.search;
  const request = useCallback((skip: number) => {
    const id = ++counter.current;
    setLoading(true);
    void loadOrderPage(session, { search, filters: JSON.parse(filters) }, timezone, skip).then(result => {
      if (id !== counter.current) return;
      if ('orders' in result) {
        setOrders(rows => skip === 0 ? result.orders : [...rows, ...result.orders.filter(order => !rows.some(row => row.id === order.id))]);
        setTotalItems(result.totalItems);
        setNotice(null);
      } else setNotice(result.notice);
      setLoading(false);
    });
  }, [session, search, filters, timezone]);
  useEffect(() => {
    // Only a search-only change waits; opening, filters and reloads run immediately.
    const inputs = [open, session, filters, timezone, attempt, search];
    const debounce = search !== previous.current[5] && inputs.slice(0, 5).every((value, index) => value === previous.current[index]);
    previous.current = inputs;
    if (!open) return;
    setLoading(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (debounce) timer = setTimeout(() => request(0), ORDER_SEARCH_DEBOUNCE_MS);
    else request(0);
    return () => { clearTimeout(timer); counter.current++; };
  }, [open, session, filters, timezone, attempt, search, request]);
  return { orders, totalItems, notice, loading,
    loadMore: () => { if (open && !loading && orders.length < totalItems) request(orders.length); },
    reload: () => { if (open) setAttempt(value => value + 1); },
  };
}
