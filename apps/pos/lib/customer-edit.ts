import { useEffect, useState } from 'react';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerAddress, type CustomerInput, type CustomerPatch, type SyncContext } from '@tallyui/core';
import { createVendureCustomer, listVendureCustomers, updateVendureCustomer } from '@tallyui/connector-vendure';
import type { AddressEditorValue, AddressFieldsProps, CustomerFormValues } from '@tallyui/components';
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
export const CUSTOMER_ADDRESS_REQUIRED_TEXT = 'An address needs its first address line and its country.';
export const CUSTOMER_ADDRESS_REMOVE_TEXT = "The till can't remove a saved address. Change it, or remove it in Vendure.";
export const CUSTOMER_ADDRESS_AFTER_CREATE_TEXT = 'The customer was added without the address. Edit the customer to add it.';
export const CUSTOMER_ADDRESS_VENDURE_TEXT = 'This store keeps extra address fields. Edit addresses in Vendure.';
export const CUSTOMER_ADDRESS_STALE_TEXT = "This customer's addresses changed in Vendure. Close the sheet and open it again.";
// The parts connector-vendure's toVendureAddressInput writes. Vendure keeps no address email, and its Address custom
// fields are not among them (a store that has any edits addresses in Vendure, see addressEditorAllowed).
const ADDRESS_PARTS = ['firstName', 'lastName', 'company', 'address1', 'address2', 'city', 'state', 'postcode', 'country', 'phone'] as const;
type AddressPatch = Pick<CustomerPatch, 'billing' | 'shipping'>;
const sameAddress = (a?: CustomerAddress, b?: CustomerAddress) => ADDRESS_PARTS.every(part => (a?.[part] ?? '') === (b?.[part] ?? ''));
/** The editor's starting value: a stored shipping address equal to billing shows as "Same as billing". */
export function addressEditorValue(stored: AddressEditorValue): AddressEditorValue {
  return { billing: stored.billing, shipping: stored.billing && sameAddress(stored.shipping, stored.billing) ? undefined : stored.shipping };
}
/**
 * The address half of a save. connector-vendure writes a sent address whole and blanks any part it lacks, so a changed
 * address goes out complete: untouched parts as stored, a cleared part as ''. An unchanged address is left out, which
 * leaves it as stored. "Same as billing" follows billing only for a customer that has a shipping address; none creates none.
 */
export function addressPatch(stored: AddressEditorValue, edited: AddressEditorValue): AddressPatch | { error: string } {
  const patch: AddressPatch = {};
  for (const kind of ['billing', 'shipping'] as const) {
    const before = stored[kind];
    const next = kind === 'shipping' && !edited.shipping && before ? edited.billing : edited[kind];
    if (!next) { if (before) return { error: CUSTOMER_ADDRESS_REMOVE_TEXT }; continue; }
    if (sameAddress(next, before)) continue;
    const sent: CustomerAddress = {};
    for (const part of ADDRESS_PARTS) if (next[part] !== undefined || before?.[part] !== undefined) sent[part] = next[part] ?? '';
    if (!sent.address1?.trim() || !sent.country) return { error: CUSTOMER_ADDRESS_REQUIRED_TEXT };
    patch[kind] = sent;
  }
  return patch;
}
/** The customer's default addresses through the connector's own read, so they map back exactly through its write. */
export async function readCustomerAddresses(context: SyncContext, id: string): Promise<AddressEditorValue | null> {
  const [customer] = (await listVendureCustomers(context, { filter: { id: { eq: id } }, take: 1 })).customers;
  return customer ? { billing: customer.billing, shipping: customer.shipping } : null;
}
async function adminRead(context: SyncContext, query: string) {
  const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal, body: JSON.stringify({ query }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json(); if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}
export const COUNTRIES_QUERY = 'query Countries { countries(options: { filter: { enabled: { eq: true } }, sort: { name: ASC }, take: 1000 }) { items { code name } } }';
export async function readCountries(context: SyncContext): Promise<NonNullable<AddressFieldsProps['countries']>> {
  return (await adminRead(context, COUNTRIES_QUERY)).countries.items.map((country: { code: string; name: string }) => ({ value: country.code, label: country.name }));
}
// CustomFieldConfig is a union, so the name comes through the CustomField interface (as barcode-field.ts reads it).
export const ADDRESS_FIELDS_QUERY = 'query AddressCustomFields { globalSettings { serverConfig { customFieldConfig { Address { ... on CustomField { name } } } } } }';
export async function readAddressCustomFields(context: SyncContext): Promise<string[]> {
  return (await adminRead(context, ADDRESS_FIELDS_QUERY)).globalSettings.serverConfig.customFieldConfig.Address.map((field: { name: string }) => field.name);
}
/**
 * connector-vendure writes an address that is both default billing and shipping as a new address from its 9 inputs, so
 * the old address's custom fields would be lost: a store with any Address custom field, or whose config can't be read, gets no editor.
 */
export function addressEditorAllowed(read: Promise<string[]>): Promise<boolean> {
  return read.then(fields => fields.length === 0, () => false);
}
const addressFieldReads = new WeakMap<Session, Promise<string[]>>();
/** Read once per session; a failed read is dropped, so the next sheet asks again. */
function sessionAddressFields(session: Session, context: SyncContext): Promise<string[]> {
  let read = addressFieldReads.get(session);
  if (!read) { addressFieldReads.set(session, read = readAddressCustomFields(context)); read.catch(() => addressFieldReads.delete(session)); }
  return read;
}
export type CustomerAddressSource = { stored: AddressEditorValue | null; countries?: AddressFieldsProps['countries']; inVendure?: boolean };
/** Read when the sheet opens: stored is null until the read answers and when it fails, so no address is written unseen. */
export function useCustomerAddresses(session: Session, open: boolean, customerId: string | null): CustomerAddressSource {
  const [source, setSource] = useState<CustomerAddressSource>({ stored: null });
  useEffect(() => {
    setSource({ stored: null }); if (!open) return;
    let cancelled = false; const context = sessionContext(session);
    // Without the countries list the country is a text field.
    void Promise.all([customerId === null ? {} : readCustomerAddresses(context, customerId), readCountries(context).catch(() => undefined),
      addressEditorAllowed(sessionAddressFields(session, context))])
      .then(([stored, countries, allowed]) => { if (!cancelled) setSource(allowed ? { stored, countries } : { stored: null, inVendure: true }); }, () => {});
    return () => { cancelled = true; };
  }, [session, open, customerId]);
  return source;
}
/** The connector picks the address it writes at write time, so the addresses must still be the ones the sheet opened with. */
async function addressesUnchanged(context: SyncContext, id: string, stored: AddressEditorValue): Promise<boolean> {
  const fresh = await readCustomerAddresses(context, id).catch(error => { if (error instanceof ConnectorUnauthorizedError) throw error; return null; });
  return fresh !== null && sameAddress(fresh.billing, stored.billing) && sameAddress(fresh.shipping, stored.shipping);
}
export async function saveCustomer(context: SyncContext, row: CustomerRow | null, values: CustomerFormValues,
  addresses?: { stored: AddressEditorValue; edited: AddressEditorValue }): Promise<{ customer: Customer } | { error: string }> {
  try {
    const address = addresses ? addressPatch(addresses.stored, addresses.edited) : {};
    if ('error' in address) return address;
    if (!row) {
      const input = customerInput(values);
      if ('error' in input) return input;
      const customer = await createVendureCustomer(context, input);
      if (Object.keys(address).length === 0) return { customer };
      // createVendureCustomer writes no address, so the addresses follow through the connector's update.
      try { return { customer: await updateVendureCustomer(context, customer.id, address) }; }
      catch (error) { return { error: `${CUSTOMER_ADDRESS_AFTER_CREATE_TEXT} ${customerSaveError(error)}` }; }
    }
    const patch = customerPatch(row, values);
    if ('error' in patch) return patch;
    if (Object.keys(patch).length + Object.keys(address).length === 0) return { error: 'Nothing to save.' };
    if (Object.keys(address).length && !(await addressesUnchanged(context, row.id, addresses!.stored))) return { error: CUSTOMER_ADDRESS_STALE_TEXT };
    return { customer: await updateVendureCustomer(context, row.id, { ...patch, ...address }) };
  } catch (error) { return { error: customerSaveError(error) }; }
}
