import { useEffect, useState } from 'react';
import type { OrderHistoryRow } from '@tallyui/components';
import { listVendureOrders, type VendureOrderSummary } from '@tallyui/connector-vendure';
import { orderHistoryNotice, toOrderHistoryRow, type OrderHistoryNotice } from './order-history';
import { sessionContext, type Session } from './session';

// Front desk ruling 2026-11-21: the 5 newest, no "Show all in Orders".
export const CUSTOMER_ORDERS_TAKE = 5;

/** The customer's newest orders (the connector sorts orderPlacedAt DESC, id DESC); never throws. */
export async function loadCustomerOrders(session: Session, customerId: string): Promise<{ orders: VendureOrderSummary[] } | { notice: OrderHistoryNotice }> {
  try {
    const { items } = await listVendureOrders(sessionContext(session), { customerId, take: CUSTOMER_ORDERS_TAKE });
    return { orders: items };
  } catch (error) {
    return { notice: orderHistoryNotice(error) };
  }
}

/** The customer's orders as Orders panel rows, or the read's notice; neither until it answers. A late answer for a closed sheet or another customer is dropped. */
export function useCustomerOrders(session: Session, customerId: string | null): { orders?: OrderHistoryRow[]; notice?: OrderHistoryNotice } {
  const [state, setState] = useState<{ orders?: OrderHistoryRow[]; notice?: OrderHistoryNotice }>({});
  useEffect(() => {
    setState({});
    if (customerId === null) return;
    let cancelled = false;
    void loadCustomerOrders(session, customerId).then(result => {
      if (!cancelled) setState('orders' in result ? { orders: result.orders.map(toOrderHistoryRow) } : result);
    });
    return () => { cancelled = true; };
  }, [session, customerId]);
  return state;
}
