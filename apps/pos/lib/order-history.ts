import { useEffect, useState } from 'react';
import type { OrderHistoryRow } from '@tallyui/components';
import { ConnectorUnauthorizedError } from '@tallyui/core';
import { listVendureOrders, type VendureOrderSummary } from '@tallyui/connector-vendure';
import { sessionContext, type Session } from './session';
import { SESSION_ENDED_TEXT } from './use-catalogue';

// One page, newest first; the panel lists recent sales, not the store's whole history.
export const ORDER_HISTORY_TAKE = 25;
export const ORDER_HISTORY_FORBIDDEN_TEXT = "This till can't read the store's orders: its role lacks the Read order permission. Ask the store's admin to add it.";
export const ORDER_HISTORY_FAILED_TEXT = "Can't load the store's orders.";
export type OrderHistoryNotice = { text: string; retry: boolean };

/** Vendure's order state code as words: PaymentSettled → "Payment settled". Custom states use the same PascalCase form. */
export function orderStateLabel(state: string): string {
  const words = state.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return words.slice(0, 1) + words.slice(1).toLowerCase();
}

/** One store order as an OrdersList history row; a POS sale keeps its client id so the till's own row replaces it. */
export function toOrderHistoryRow(order: VendureOrderSummary): OrderHistoryRow {
  return {
    id: order.id, reference: order.code, placedAt: order.orderPlacedAt ?? order.updatedAt,
    totalMinor: order.totalWithTax, currency: order.currencyCode, itemCount: order.totalQuantity,
    stateLabel: orderStateLabel(order.state),
    ...(order.customFields?.tallyClientOrderId ? { clientOrderId: order.customFields.tallyClientOrderId } : {}),
  };
}

export function orderHistoryNotice(error: unknown): OrderHistoryNotice {
  if (error instanceof ConnectorUnauthorizedError) {
    return { text: error.status === 403 ? ORDER_HISTORY_FORBIDDEN_TEXT : SESSION_ENDED_TEXT, retry: false };
  }
  return { text: ORDER_HISTORY_FAILED_TEXT, retry: true };
}

export async function loadOrderHistory(session: Session): Promise<{ orders: VendureOrderSummary[] } | { notice: OrderHistoryNotice }> {
  try {
    const { items } = await listVendureOrders(sessionContext(session), { take: ORDER_HISTORY_TAKE });
    return { orders: items };
  } catch (error) {
    return { notice: orderHistoryNotice(error) };
  }
}

export function useOrderHistory(session: Session, open: boolean): {
  orders: VendureOrderSummary[]; notice: OrderHistoryNotice | null; loading: boolean; reload(): void;
} {
  const [orders, setOrders] = useState<VendureOrderSummary[]>([]);
  const [notice, setNotice] = useState<OrderHistoryNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void loadOrderHistory(session).then(result => {
      if (cancelled) return;
      if ('orders' in result) {
        setOrders(result.orders);
        setNotice(null);
      } else setNotice(result.notice);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, session, attempt]);
  return { orders, notice, loading, reload: () => setAttempt(value => value + 1) };
}
