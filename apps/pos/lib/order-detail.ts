import { useEffect, useState } from 'react';
import type { OrderHistoryRow, OrderStatus } from '@tallyui/components';
import { getVendureOrder, type VendureOrder } from '@tallyui/connector-vendure';
import { formatMoney } from '@tallyui/core';
import type { PosOrder } from '@tallyui/pos';
import { orderHistoryNotice, orderStateLabel, type OrderHistoryNotice } from './order-history';
import { sessionContext, type Session } from './session';

export const ORDER_NOT_SYNCED_TEXT = "This sale hasn't reached the store yet. You can open it here once it has synced.";
export const ORDER_GONE_TEXT = "This order isn't in the store any more.";
export const ORDER_DETAIL_FAILED_TEXT = "Can't load this order.";
export const ORDER_LOADING_TEXT = 'Loading the order…';

/** The Vendure id to read for a row, or the note shown instead when the store has no order for it yet. */
export function orderDetailTarget(row: PosOrder | OrderHistoryRow): { orderId: string } | { note: string } {
  if ('syncStatus' in row) {
    // The plugin sets serverRefs.orderId to the Vendure order's id when it applies the sale.
    return row.syncStatus === 'applied' && row.serverRefs?.orderId ? { orderId: row.serverRefs.orderId } : { note: ORDER_NOT_SYNCED_TEXT };
  }
  return { orderId: row.id };
}

const COMPLETED_STATES = new Set(['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered']);
const PENDING_STATES = new Set(['ArrangingPayment', 'PaymentAuthorized']);

/** Vendure's order state as OrderDetail's badge. */
export function toOrderStatus(state: string): OrderStatus {
  if (state === 'Cancelled') return 'cancelled';
  if (COMPLETED_STATES.has(state)) return 'completed';
  if (PENDING_STATES.has(state)) return 'pending';
  return 'processing';
}

export type OrderDetailView = {
  orderNumber: string; status: OrderStatus; lineItems: { name: string; quantity: number; total: string }[];
  subtotal: string; tax: string; total: string;
  payments: { id: string; text: string; refunds: { id: string; text: string }[] }[];
};

/** The order's own figures as text; the only arithmetic is tax = totalWithTax - total. */
export function orderDetailView(order: VendureOrder): OrderDetailView {
  const money = (amount: number) => formatMoney({ amount, currency: order.currencyCode }) ?? '';
  return {
    orderNumber: order.code,
    status: toOrderStatus(order.state),
    lineItems: order.lines.map(line => ({
      name: line.customFields?.tallyCustomName || line.productVariant.name,
      quantity: line.quantity,
      total: money(line.proratedLinePriceWithTax),
    })),
    subtotal: money(order.subTotalWithTax),
    tax: money(order.totalWithTax - order.total),
    total: money(order.totalWithTax),
    payments: (order.payments ?? []).map(payment => ({
      id: payment.id,
      text: `Paid ${money(payment.amount)} · ${orderStateLabel(payment.state)}`,
      refunds: payment.refunds.map(refund => ({ id: refund.id, text: `Refunded ${money(refund.total)} · ${orderStateLabel(refund.state)}` })),
    })),
  };
}

/** Errors as OrderHistoryNotice: 401/403 as orderHistoryNotice says them, anything else ORDER_DETAIL_FAILED_TEXT with a retry. */
export function orderDetailNotice(error: unknown): OrderHistoryNotice {
  const notice = orderHistoryNotice(error);
  return notice.retry ? { text: ORDER_DETAIL_FAILED_TEXT, retry: true } : notice;
}

export function useOrderDetail(session: Session, orderId: string | null): {
  order: VendureOrder | null; notice: OrderHistoryNotice | null; loading: boolean; reload(): void;
} {
  const [order, setOrder] = useState<VendureOrder | null>(null);
  const [notice, setNotice] = useState<OrderHistoryNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Another order (or store) never shows the previous one's figures; a reload keeps them.
  useEffect(() => {
    setOrder(null);
    setNotice(null);
  }, [session, orderId]);
  useEffect(() => {
    if (orderId === null) return;
    let cancelled = false;
    setLoading(true);
    void getVendureOrder(sessionContext(session), orderId).then(found => {
      if (cancelled) return;
      setOrder(found);
      setNotice(found ? null : { text: ORDER_GONE_TEXT, retry: false });
      setLoading(false);
    }, (error: unknown) => {
      if (cancelled) return;
      setNotice(orderDetailNotice(error));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [session, orderId, attempt]);
  return { order, notice, loading, reload: () => setAttempt(value => value + 1) };
}
