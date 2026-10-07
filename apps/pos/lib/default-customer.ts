import { useEffect, useRef } from 'react';
import type { CustomerSummary, useSale } from '@tallyui/pos';
import { defaultStore, type KeyValueStore, type Session } from './session';

export const DEFAULT_CUSTOMER_KEY = 'vendurepos.till.defaultCustomer';

export function loadDefaultCustomer(session: Pick<Session, 'url' | 'channelToken'>, store: KeyValueStore = defaultStore()): CustomerSummary | null {
  const value = store.getItem(`${DEFAULT_CUSTOMER_KEY}:${session.url}|${session.channelToken ?? ''}`);
  if (value === null) return null;
  try {
    const customer = JSON.parse(value);
    if (typeof customer?.id !== 'string' || customer.id.length === 0 || typeof customer?.name !== 'string' || customer.name.length === 0) return null;
    return { id: customer.id, name: customer.name, ...(typeof customer.email === 'string' ? { email: customer.email } : {}) };
  } catch {
    return null;
  }
}

export function saveDefaultCustomer(session: Pick<Session, 'url' | 'channelToken'>, customer: CustomerSummary | null, store: KeyValueStore = defaultStore()): void {
  const key = `${DEFAULT_CUSTOMER_KEY}:${session.url}|${session.channelToken ?? ''}`;
  if (customer === null) store.removeItem(key);
  else store.setItem(key, JSON.stringify({ id: customer.id, name: customer.name, email: customer.email }));
}

export function useDefaultCustomer(sale: Pick<ReturnType<typeof useSale>, 'stage' | 'order' | 'setCustomer'>, session: Session): void {
  const lastOrderId = useRef<string | null>(null);
  useEffect(() => {
    if (sale.stage.kind !== 'cart') return;
    if (sale.order.id === lastOrderId.current) return;
    lastOrderId.current = sale.order.id;
    if (sale.order.lineItems.length === 0 && sale.order.customer === null) {
      const customer = loadDefaultCustomer(session);
      if (customer !== null) sale.setCustomer(customer);
    }
  }, [sale.order.id, sale.stage.kind]);
}
