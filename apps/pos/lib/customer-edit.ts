import { useEffect, useState } from 'react';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerInput, type CustomerPatch, type SyncContext } from '@tallyui/core';
import { createVendureCustomer, updateVendureCustomer } from '@tallyui/connector-vendure';
import type { CustomerFormValues } from '@tallyui/components';
import type { CustomerRow } from './customer-list';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { sessionContext, type Session } from './session';

export const CUSTOMER_EMAIL_REQUIRED_TEXT = "Enter the customer's email address.";
export const CUSTOMER_OFFLINE_TEXT = 'The till is offline. Customers are saved straight to the store, so connect to add or change one.';
export const CUSTOMER_SAVE_FORBIDDEN_TEXT = "This till's role can't add or change the store's customers. Ask the store's admin to add the Create customer and Update customer permissions.";
export const CUSTOMER_SAVE_FAILED_TEXT = "The store didn't save this customer";
export const CUSTOMER_CREATE_PERMISSION = 'CreateCustomer', CUSTOMER_UPDATE_PERMISSION = 'UpdateCustomer';
export type CustomerAccess = { create: boolean; update: boolean };
const NO_ACCESS: CustomerAccess = { create: false, update: false };

export async function customerAccess(context: SyncContext): Promise<CustomerAccess> {
  try {
    const query = 'query CustomerPermissions { me { channels { id permissions } } activeChannel { id } }';
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ query }) });
    if (!response.ok) return NO_ACCESS;
    const body = await response.json();
    if (body.errors?.length) return NO_ACCESS;
    const channel = body.data?.me?.channels?.find((channel: { id: string; permissions: string[] }) => channel.id === body.data?.activeChannel?.id);
    return channel ? { create: channel.permissions.includes(CUSTOMER_CREATE_PERMISSION), update: channel.permissions.includes(CUSTOMER_UPDATE_PERMISSION) } : NO_ACCESS;
  } catch { return NO_ACCESS; }
}
export function useCustomerAccess(session: Session): CustomerAccess {
  const [access, setAccess] = useState(NO_ACCESS);
  useEffect(() => {
    setAccess(NO_ACCESS);
    let cancelled = false;
    customerAccess(sessionContext(session)).then(result => { if (!cancelled) setAccess(result); });
    return () => { cancelled = true; };
  }, [session]);
  return access;
}
export function customerFormValues(row: CustomerRow | null): CustomerFormValues {
  return { firstName: row?.firstName ?? '', lastName: row?.lastName ?? '', email: row?.email ?? '', phone: row?.phone ?? '', address: '' };
}
export function customerInput(values: CustomerFormValues): CustomerInput | { error: string } {
  const email = values.email.trim(), phone = values.phone.trim();
  if (!email) return { error: CUSTOMER_EMAIL_REQUIRED_TEXT };
  return { firstName: values.firstName.trim(), lastName: values.lastName.trim(), email, ...(phone ? { phone } : {}) };
}
export function customerPatch(row: CustomerRow, values: CustomerFormValues): CustomerPatch | { error: string } {
  if (!values.email.trim()) return { error: CUSTOMER_EMAIL_REQUIRED_TEXT };
  const patch: CustomerPatch = {};
  for (const field of ['firstName', 'lastName', 'email', 'phone'] as const) {
    const value = values[field].trim();
    if (value !== (row[field] ?? '')) patch[field] = value;
  }
  return patch;
}
export function customerSaveError(error: unknown): string {
  if (error instanceof ConnectorUnauthorizedError) return error.status === 403 ? CUSTOMER_SAVE_FORBIDDEN_TEXT : SESSION_ENDED_TEXT;
  if (error instanceof CustomerServiceError) {
    if (error.code === 'invalid') return error.message;
    if (error.code === 'network') return CUSTOMER_OFFLINE_TEXT;
    if (error.code === 'server') return `${CUSTOMER_SAVE_FAILED_TEXT}: ${error.message.replace(/^Vendure (?:GraphQL|API) error: /, '')}.`;
  }
  return `${CUSTOMER_SAVE_FAILED_TEXT}. Try again.`;
}
export async function saveCustomer(context: SyncContext, row: CustomerRow | null, values: CustomerFormValues): Promise<{ customer: Customer } | { error: string }> {
  try {
    if (!row) {
      const input = customerInput(values);
      return 'error' in input ? input : { customer: await createVendureCustomer(context, input) };
    }
    const patch = customerPatch(row, values);
    if ('error' in patch) return patch;
    if (Object.keys(patch).length === 0) return { error: 'Nothing to save.' };
    return { customer: await updateVendureCustomer(context, row.id, patch) };
  } catch (error) { return { error: customerSaveError(error) }; }
}
