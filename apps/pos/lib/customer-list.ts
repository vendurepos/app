import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectorUnauthorizedError, type SyncContext } from '@tallyui/core';
import type { OrderHistoryNotice } from './order-history';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { sessionContext, type Session } from './session';

// v2's table shows 20–25 rows before "load more"; the same page as the Orders table.
export const CUSTOMER_PAGE_SIZE = 25;
// Wait for typing to pause so each key press is not a request.
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;
// The vendurepos plugin's walk-in customer (connector-vendure's WALK_IN_EMAIL, not exported) is never listed.
export const WALK_IN_EMAIL = 'walk-in@vendurepos.local';
// A missing customer permission needs the store admin's help.
export const CUSTOMERS_FORBIDDEN_TEXT = "This till can't read the store's customers: its role lacks the Read customer permission. Ask the store's admin to add it.";
// Other failures can be retried from the list.
export const CUSTOMERS_FAILED_TEXT = "Can't load the store's customers.";

export type VendureCustomerAddress = {
  fullName?: string | null; company?: string | null; streetLine1?: string | null; streetLine2?: string | null;
  city?: string | null; province?: string | null; postalCode?: string | null; country?: { code: string } | null;
  defaultBillingAddress?: boolean | null;
};
export type VendureCustomerListItem = {
  id: string; firstName?: string | null; lastName?: string | null; emailAddress?: string | null;
  phoneNumber?: string | null; createdAt: string; addresses?: VendureCustomerAddress[] | null;
};
export type CustomerRow = {
  id: string; firstName: string; lastName: string; email: string; phone: string | null;
  /** The default billing address as display lines; [] when the customer has none. */
  billingAddress: string[];
  createdAt: string;
};

export function customerListOptions(search: string, skip: number) {
  const q = search.trim();
  return { skip, take: CUSTOMER_PAGE_SIZE, sort: { lastName: 'ASC' }, filter: {
    emailAddress: { notEq: WALK_IN_EMAIL },
    ...(q ? { _or: [{ firstName: { contains: q } }, { lastName: { contains: q } },
      { emailAddress: { contains: q } }, { phoneNumber: { contains: q } }] } : {}),
  } };
}
export function toCustomerRow(item: VendureCustomerListItem): CustomerRow {
  const address = item.addresses?.find(address => address.defaultBillingAddress === true);
  // Two lines, as v2's customer table (Front desk, #245 polish): the street, then the town and postcode with the country.
  const billingAddress = address ? [
    [address.streetLine1, address.streetLine2].filter(Boolean).join(', '),
    [[address.city, address.province, address.postalCode].filter(Boolean).join(' '), address.country?.code].filter(Boolean).join(', '),
  ].filter((line): line is string => !!line) : [];
  return { id: item.id, firstName: item.firstName ?? '', lastName: item.lastName ?? '', email: item.emailAddress ?? '',
    phone: item.phoneNumber ?? null, billingAddress, createdAt: item.createdAt };
}
export async function listVendureCustomerPage(context: SyncContext, options: ReturnType<typeof customerListOptions>): Promise<{ items: VendureCustomerListItem[]; totalItems: number }> {
  const query = `query CustomerList($options: CustomerListOptions) {
    customers(options: $options) {
      totalItems
      items {
        id firstName lastName emailAddress phoneNumber createdAt
        addresses { fullName company streetLine1 streetLine2 city province postalCode country { code } defaultBillingAddress }
      }
    }
  }`;
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query, variables: { options } }),
  });
  if (response.status === 401 || response.status === 403) throw new ConnectorUnauthorizedError(`Vendure API error: ${response.status}`, response.status);
  if (!response.ok) throw new Error(`Vendure API error: ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) {
    const error = body.errors[0];
    // Vendure answers a missing permission with HTTP 200 and FORBIDDEN. An ended session answers the same; the catalogue's own sync signs the till out then.
    if (error.extensions?.code === 'FORBIDDEN') throw new ConnectorUnauthorizedError(error.message, 403);
    throw new Error(error.message);
  }
  return body.data.customers;
}
export function customerListNotice(error: unknown): OrderHistoryNotice {
  if (error instanceof ConnectorUnauthorizedError) {
    return { text: error.status === 403 ? CUSTOMERS_FORBIDDEN_TEXT : SESSION_ENDED_TEXT, retry: false };
  }
  return { text: CUSTOMERS_FAILED_TEXT, retry: true };
}
export async function loadCustomerPage(session: Session, search: string, skip: number): Promise<{ customers: CustomerRow[]; totalItems: number } | { notice: OrderHistoryNotice }> {
  try {
    const { items, totalItems } = await listVendureCustomerPage(sessionContext(session), customerListOptions(search, skip));
    return { customers: items.map(toCustomerRow), totalItems };
  } catch (error) { return { notice: customerListNotice(error) }; }
}

export function useCustomerList(session: Session, open: boolean, search: string): {
  customers: CustomerRow[]; totalItems: number; notice: OrderHistoryNotice | null; loading: boolean; loadMore(): void; reload(): void;
} {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [notice, setNotice] = useState<OrderHistoryNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const counter = useRef(0), previous = useRef<unknown[]>([]);
  const request = useCallback((skip: number) => {
    counter.current += 1;
    const id = counter.current;
    setLoading(true);
    void loadCustomerPage(session, search, skip).then(result => {
      if (id !== counter.current) return;
      if ('customers' in result) {
        setCustomers(rows => skip === 0 ? result.customers : [...rows, ...result.customers.filter(customer => !rows.some(row => row.id === customer.id))]);
        setTotalItems(result.totalItems);
        setNotice(null);
      } else setNotice(result.notice);
      setLoading(false);
    });
  }, [session, search]);
  useEffect(() => {
    // Only a search-only change waits; opening and reloads run immediately.
    const inputs = [open, session, attempt, search];
    const debounce = search !== previous.current[3] && inputs.slice(0, 3).every((value, index) => value === previous.current[index]);
    previous.current = inputs;
    if (!open) return;
    setLoading(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (debounce) timer = setTimeout(() => request(0), CUSTOMER_SEARCH_DEBOUNCE_MS);
    else request(0);
    return () => { clearTimeout(timer); counter.current += 1; };
  }, [open, session, attempt, search, request]);
  return { customers, totalItems, notice, loading,
    loadMore: () => { if (open && !loading && customers.length < totalItems) request(customers.length); },
    reload: () => { if (open) setAttempt(value => value + 1); },
  };
}
