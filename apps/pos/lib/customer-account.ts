import { useEffect, useState } from 'react';
import type { SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';
export const CUSTOMER_ACCOUNT_QUERY = `query CustomerAccount($id: ID!) { customer(id: $id) { id user { id verified } } }`;
// Vendure's counterpart of v2's read-only Username row: the customer's User, or none for a guest.
export const CUSTOMER_ACCOUNT_LABEL = 'Account';
export function customerAccountText(user: { verified: boolean } | null): string {
  return user === null ? 'Guest' : user.verified ? 'Registered · email verified' : 'Registered · not verified';
}
/** One Admin API read of the customer's account; throws on HTTP or GraphQL errors; null when the customer is not found. */
export async function readCustomerAccount(context: SyncContext, customerId: string): Promise<string | null> {
  const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal, body: JSON.stringify({ query: CUSTOMER_ACCOUNT_QUERY, variables: { id: customerId } }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json(); if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data.customer === null ? null : customerAccountText(body.data.customer.user);
}
/** The account text: null when customerId is null, until the read answers, and when it fails or is refused. */
export function useCustomerAccount(session: Session, customerId: string | null): string | null {
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    setAccount(null); if (customerId === null) return;
    let cancelled = false;
    void readCustomerAccount(sessionContext(session), customerId).then(found => { if (!cancelled) setAccount(found); }, () => {});
    return () => { cancelled = true; };
  }, [session, customerId]);
  return account;
}
