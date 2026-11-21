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
export const CUSTOMER_GROUPS_LABEL = 'Groups';
// v2's "Set in WordPress" for a field the till does not edit.
export const CUSTOMER_GROUPS_HINT = 'Set in Vendure';

export type VendureCustomerAddress = {
  fullName?: string | null; company?: string | null; streetLine1?: string | null; streetLine2?: string | null;
  city?: string | null; province?: string | null; postalCode?: string | null; country?: { code: string } | null;
  defaultBillingAddress?: boolean | null;
};
export type VendureCustomerListItem = {
  id: string; firstName?: string | null; lastName?: string | null; emailAddress?: string | null;
  phoneNumber?: string | null; createdAt: string; addresses?: VendureCustomerAddress[] | null;
  groups?: Array<{ id: string; name: string }> | null;
};
export type CustomerRow = {
  id: string; firstName: string; lastName: string; email: string; phone: string | null;
  /** The default billing address as display lines; [] when the customer has none. */
  billingAddress: string[];
  /** The customer's Vendure customer group names, sorted by name; [] when it has none. */
  groups: string[];
  createdAt: string;
};

export function customerGroupsText(row: CustomerRow | null): string | null {
  return row?.groups.length ? row.groups.join(', ') : null;
}

export type CustomerSortField = 'firstName' | 'lastName' | 'emailAddress' | 'createdAt';
export type CustomerSort = { field: CustomerSortField; dir: 'ASC' | 'DESC' };
// v2's customers table opens sorted by last name, ascending ("LAST NAME ^").
export const DEFAULT_CUSTOMER_SORT: CustomerSort = { field: 'lastName', dir: 'ASC' };
/** A press on the sorted column flips it; a press on another column sorts that one ascending. */
export function nextCustomerSort(current: CustomerSort, field: CustomerSortField): CustomerSort {
  return { field, dir: current.field === field && current.dir === 'ASC' ? 'DESC' : 'ASC' };
}
export function customerListOptions(search: string, skip: number, sort = DEFAULT_CUSTOMER_SORT) {
  const q = search.trim();
  return { skip, take: CUSTOMER_PAGE_SIZE, sort: { [sort.field]: sort.dir }, filter: {
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
    phone: item.phoneNumber ?? null, billingAddress, createdAt: item.createdAt,
    groups: (item.groups ?? []).map(group => group.name).sort((a, b) => a.localeCompare(b)) };
}
export async function listVendureCustomerPage(context: SyncContext, options: ReturnType<typeof customerListOptions>): Promise<{ items: VendureCustomerListItem[]; totalItems: number }> {
  const query = `query CustomerList($options: CustomerListOptions) {
    customers(options: $options) {
      totalItems
      items {
        id firstName lastName emailAddress phoneNumber createdAt
        groups { id name }
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
/**
 * Whether this till's role may read the store's customers (Front desk ruling on #245: a role without Read customer
 * sees no Customers door). Asks for an empty page through the panel's own query: only Vendure's FORBIDDEN hides the
 * door. A 401 is an ended session the catalogue sync signs out, and a failure is the panel's notice to show.
 */
export async function customersReadable(context: SyncContext): Promise<boolean> {
  try {
    await listVendureCustomerPage(context, { ...customerListOptions('', 0), take: 0 });
    return true;
  } catch (error) {
    return !(error instanceof ConnectorUnauthorizedError && error.status === 403);
  }
}

/** `customersReadable` for the signed-in session: false until it answers, so a refused role never sees the door. */
export function useCustomersReadable(session: Session): boolean {
  const [readable, setReadable] = useState(false);
  useEffect(() => {
    setReadable(false);
    let cancelled = false;
    customersReadable(sessionContext(session)).then(result => { if (!cancelled) setReadable(result); });
    return () => { cancelled = true; };
  }, [session]);
  return readable;
}
export function customerListNotice(error: unknown): OrderHistoryNotice {
  if (error instanceof ConnectorUnauthorizedError) {
    return { text: error.status === 403 ? CUSTOMERS_FORBIDDEN_TEXT : SESSION_ENDED_TEXT, retry: false };
  }
  return { text: CUSTOMERS_FAILED_TEXT, retry: true };
}
export async function loadCustomerPage(session: Session, search: string, skip: number, sort = DEFAULT_CUSTOMER_SORT): Promise<{ customers: CustomerRow[]; totalItems: number } | { notice: OrderHistoryNotice }> {
  try {
    const { items, totalItems } = await listVendureCustomerPage(sessionContext(session), customerListOptions(search, skip, sort));
    return { customers: items.map(toCustomerRow), totalItems };
  } catch (error) { return { notice: customerListNotice(error) }; }
}

export function useCustomerList(session: Session, open: boolean, search: string, sort = DEFAULT_CUSTOMER_SORT): {
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
    void loadCustomerPage(session, search, skip, sort).then(result => {
      if (id !== counter.current) return;
      if ('customers' in result) {
        setCustomers(rows => skip === 0 ? result.customers : [...rows, ...result.customers.filter(customer => !rows.some(row => row.id === customer.id))]);
        setTotalItems(result.totalItems);
        setNotice(null);
      } else setNotice(result.notice);
      setLoading(false);
    });
  }, [session, search, sort]);
  useEffect(() => {
    // Only a search-only change waits; opening and reloads run immediately.
    const inputs = [open, session, attempt, sort, search];
    const debounce = search !== previous.current[4] && inputs.slice(0, 4).every((value, index) => value === previous.current[index]);
    previous.current = inputs;
    if (!open) return;
    setLoading(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (debounce) timer = setTimeout(() => request(0), CUSTOMER_SEARCH_DEBOUNCE_MS);
    else request(0);
    return () => { clearTimeout(timer); counter.current += 1; };
  }, [open, session, attempt, sort, search, request]);
  return { customers, totalItems, notice, loading,
    loadMore: () => { if (open && !loading && customers.length < totalItems) request(customers.length); },
    reload: () => { if (open) setAttempt(value => value + 1); },
  };
}
