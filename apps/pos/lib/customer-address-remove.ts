import { useEffect, useState } from 'react';
import type { SyncContext } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { CUSTOMER_OFFLINE_TEXT } from './customer-edit';
import { sessionContext, type Session } from './session';

export type SavedAddress = { id: string; street: string; city: string; billing: boolean; shipping: boolean };
export const SAVED_ADDRESSES_QUERY = 'query CustomerAddressIds($id: ID!) { customer(id: $id) { addresses { id streetLine1 city defaultBillingAddress defaultShippingAddress } } }';
export const DELETE_ADDRESS_MUTATION = 'mutation DeleteCustomerAddress($id: ID!) { deleteCustomerAddress(id: $id) { success } }';
export const CUSTOMER_ADDRESS_REMOVE_FAILED_TEXT = "The store didn't remove this address, so it is still saved";
export const CUSTOMER_ADDRESS_REMOVE_FORBIDDEN_TEXT = "This till's role can't remove the store's customer addresses. Ask the store's admin to add the Delete customer permission.";
export const CUSTOMER_ADDRESS_REMOVE_UNSAVED_TEXT = 'Save or undo the address changes before removing an address.';

type RawAddress = { id: string; streetLine1?: string | null; city?: string | null; defaultBillingAddress?: boolean; defaultShippingAddress?: boolean };

/** One Admin API read of the customer's saved addresses, in Vendure's order; throws on HTTP or GraphQL errors; [] for no customer. */
export async function readSavedAddresses(context: SyncContext, customerId: string): Promise<SavedAddress[]> {
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal,
    body: JSON.stringify({ query: SAVED_ADDRESSES_QUERY, variables: { id: customerId } }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  if (!body.data?.customer) return [];
  return body.data.customer.addresses.map((address: RawAddress) => ({ id: address.id, street: address.streetLine1 ?? '', city: address.city ?? '',
    billing: address.defaultBillingAddress === true, shipping: address.defaultShippingAddress === true }));
}

/** The default billing and shipping addresses, billing first; one address that is both appears once. */
export function removableAddresses(all: SavedAddress[]): SavedAddress[] {
  const billing = all.find(address => address.billing), shipping = all.find(address => address.shipping);
  return [billing, shipping].filter((address, index, list): address is SavedAddress => address !== undefined && list.indexOf(address) === index);
}

export function savedAddressName(address: SavedAddress): string {
  return [address.street, address.city].filter(Boolean).join(', ');
}

export function savedAddressRole(address: SavedAddress): string {
  return address.billing && address.shipping ? 'Billing and shipping' : address.billing ? 'Billing' : 'Shipping';
}

/** The confirm step's two lines: what is removed, and which address Vendure makes the default in its place. */
export function removeConfirmText(address: SavedAddress, all: SavedAddress[], customerName: string): string[] {
  const role = savedAddressRole(address).toLowerCase();
  return [`Remove ${savedAddressName(address)} from ${customerName}'s account in Vendure?`,
    all.some(other => other.id !== address.id)
      ? `It is the default ${role} address, so Vendure makes the customer's oldest other saved address the default.`
      : `It is the default ${role} address, and the customer has no other saved address.`];
}

/** Removes one saved address in Vendure; never throws and never queues. */
export async function removeCustomerAddress(context: SyncContext, addressId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const response = await fetch(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal,
      body: JSON.stringify({ query: DELETE_ADDRESS_MUTATION, variables: { id: addressId } }),
    });
    if (response.status === 401) return { error: SESSION_ENDED_TEXT };
    if (response.status === 403) return { error: CUSTOMER_ADDRESS_REMOVE_FORBIDDEN_TEXT };
    const body = await response.json().catch(() => ({}));
    const errors: { message: string; extensions?: { code?: string } }[] | undefined = body.errors;
    if (errors?.some(error => error.extensions?.code === 'FORBIDDEN')) return { error: CUSTOMER_ADDRESS_REMOVE_FORBIDDEN_TEXT };
    if (errors?.length) return { error: `${CUSTOMER_ADDRESS_REMOVE_FAILED_TEXT}: ${errors[0].message}.` };
    if (response.ok && body.data?.deleteCustomerAddress?.success === true) return { ok: true };
    return { error: `${CUSTOMER_ADDRESS_REMOVE_FAILED_TEXT}. Try again.` };
  } catch {
    return { error: CUSTOMER_OFFLINE_TEXT };
  }
}

/** The customer's saved addresses: null until the read answers, when it fails, and when customerId is null; a new version reads again. */
export function useSavedAddresses(session: Session, customerId: string | null, version: number): SavedAddress[] | null {
  const [saved, setSaved] = useState<SavedAddress[] | null>(null);
  useEffect(() => {
    setSaved(null);
    if (customerId === null) return;
    let cancelled = false;
    readSavedAddresses(sessionContext(session), customerId).then(found => { if (!cancelled) setSaved(found); }, () => {});
    return () => { cancelled = true; };
  }, [session, customerId, version]);
  return saved;
}
