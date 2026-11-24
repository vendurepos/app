import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddressEditorValue, AddressFieldsProps } from '@tallyui/components';
import type { CustomerAddress } from '@tallyui/core';
import { UNTAXED_ADDRESS_ORDER_CREATE_VERSION, type PosOrder, type useSale } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { ADDRESS_PARTS, CUSTOMER_ADDRESS_REQUIRED_TEXT, readCountries, readCustomerAddresses } from './customer-edit';
import { defaultStore, sessionContext, sessionKey, type Session } from './session';
import { canSendWithoutAddress } from './store-health';

/** /info's taxZone (plugin 5.2a): whether the store's zone can follow the address, and its default tax zone's countries. */
export type TaxZone = { byAddress: boolean; countries: string[] };
// Device storage for the store's last good /info taxZone (raw JSON), one per session key, as use-tender-methods.ts keeps its list.
export const TAX_ZONE_KEY = 'vendurepos.tax_zone';
export const ADDRESS_ZONE_BLOCK_TEXT = "This store taxes by the customer's address, and this address is outside the till's tax zone. Remove the address to take payment.";
export const ADDRESS_PART_TOO_LONG_TEXT = 'An address line can be at most 255 characters. Shorten it to save.';
const ADDRESS_PART_MAX = 255; // Plugin order.create v11 refuses a longer address value, after payment (invalid_payload).
type Sale = ReturnType<typeof useSale>;
type Requeue = (orderIds: string[]) => Promise<number>;
/** The taxZone value when both fields have their shape, else undefined (an older plugin, or a body we can't read). */
export function parseTaxZone(value: unknown): TaxZone | undefined {
  const zone = value as Partial<TaxZone> | null | undefined;
  if (typeof zone?.byAddress !== 'boolean' || !Array.isArray(zone.countries) || !zone.countries.every(c => typeof c === 'string')) return undefined;
  return { byAddress: zone.byAddress, countries: [...zone.countries] };
}
const stored = (key: string) => { try { return defaultStore().getItem(key); } catch { return null; } };
/** The store's /info taxZone, read on mount and per session; a failed read keeps the last good one, an answer without it clears it. */
export function useTaxZone(session: Session): TaxZone | undefined {
  const sessionRef = useRef(session); sessionRef.current = session;
  const key = `${TAX_ZONE_KEY}:${sessionKey(session)}`;
  const [entry, setEntry] = useState(() => ({ key, json: stored(key) }));
  const json = entry.key === key ? entry.json : stored(key);
  useEffect(() => {
    const unmount = new AbortController();
    void (async () => {
      const response = await fetch(`${sessionRef.current.url}/tally/v1/info`, { headers: sessionContext(sessionRef.current).headers, signal: unmount.signal });
      if (!response.ok) return;
      const zone = parseTaxZone(((await response.json()) as { taxZone?: unknown } | null)?.taxZone);
      if (unmount.signal.aborted) return;
      const next = zone ? JSON.stringify(zone) : null; setEntry({ key, json: next });
      if (next) defaultStore().setItem(key, next); else defaultStore().removeItem(key);
    })().catch(() => {}); // Offline, aborted or unreadable: the last good taxZone stands.
    return () => unmount.abort();
  }, [key]);
  return useMemo(() => { try { return parseTaxZone(JSON.parse(json ?? 'null')); } catch { return undefined; } }, [json]);
}
/** True only when the store taxes by address and either address's country is outside the till's zone. */
export function addressBlocked(taxZone: TaxZone | undefined, billing?: CustomerAddress, shipping?: CustomerAddress): boolean {
  return taxZone?.byAddress === true && [billing?.country, shipping?.country].some(country => !!country && !taxZone.countries.includes(country));
}
/** The ten parts plugin v11 takes, empty ones dropped; never `email` (it would be refused after payment). */
export function addressCopy(address: CustomerAddress | undefined): CustomerAddress | undefined {
  const copy: CustomerAddress = {};
  for (const part of ADDRESS_PARTS) if (address?.[part]?.trim()) copy[part] = address[part];
  return Object.keys(copy).length ? copy : undefined;
}
/** The editor's value as the sale's addresses ("Same as billing" is shipping undefined), or why the store would refuse it. */
export function saleAddresses(value: AddressEditorValue): { billing?: CustomerAddress; shipping?: CustomerAddress } | { error: string } {
  const billing = addressCopy(value.billing), shipping = addressCopy(value.shipping);
  for (const address of [billing, shipping]) {
    if (address && (!address.address1 || !address.country)) return { error: CUSTOMER_ADDRESS_REQUIRED_TEXT };
    if (address && ADDRESS_PARTS.some(part => (address[part]?.length ?? 0) > ADDRESS_PART_MAX)) return { error: ADDRESS_PART_TOO_LONG_TEXT };
  }
  return { billing, shipping };
}
export const hasAddress = (sale: Pick<Sale, 'order'>): boolean => !!(sale.order.customer?.billing || sale.order.customer?.shipping);
/** Whether a picked customer's defaults are read into the sale: once per order and customer (so a Remove is never refilled). */
export function shouldPrefill(facts: { key: string | null; seen: string | null; cart: boolean; hasAddress: boolean; orderCreate?: number; taxZone?: TaxZone }): boolean {
  return facts.key !== null && facts.key !== facts.seen && facts.cart && !facts.hasAddress && (facts.orderCreate ?? 0) >= UNTAXED_ADDRESS_ORDER_CREATE_VERSION && facts.taxZone !== undefined;
}
/** Pins the picked customer's default addresses to the sale, from the picker and from the default customer alike. */
export function useSaleAddressPrefill(sale: Sale, session: Session, taxZone: TaxZone | undefined, orderCreate: number | undefined): void {
  const saleRef = useRef(sale), seen = useRef<string | null>(null); saleRef.current = sale;
  const orderId = sale.order.id, customerId = sale.order.customer?.id ?? null, cart = sale.stage.kind === 'cart', pinned = hasAddress(sale);
  useEffect(() => {
    const key = customerId === null ? null : `${orderId}|${customerId}`;
    // A sale that already has an address uses up its key too, so a later Remove stays removed.
    if (!shouldPrefill({ key, seen: seen.current, cart, hasAddress: false, orderCreate, taxZone })) return;
    seen.current = key;
    if (pinned) return;
    void readCustomerAddresses(sessionContext(session), customerId!).then(read => {
      const now = saleRef.current;
      if (!read || now.order.id !== orderId || now.order.customer?.id !== customerId || now.stage.kind !== 'cart' || hasAddress(now)) return;
      const addresses = saleAddresses(read);
      if (!('error' in addresses) && (addresses.billing || addresses.shipping)) now.setAddresses(addresses.billing, addresses.shipping);
    }, () => {});
  }, [orderId, customerId, cart, pinned, orderCreate, taxZone, session]);
}
const countryReads = new WeakMap<Session, Promise<NonNullable<AddressFieldsProps['countries']>>>();
/** The store's countries, read once per session; undefined until read and when the read fails (dropped, so the next mount asks again). */
export function useSaleCountries(session: Session, wanted: boolean): AddressFieldsProps['countries'] {
  const [countries, setCountries] = useState<AddressFieldsProps['countries']>();
  useEffect(() => {
    if (!wanted) return;
    let read = countryReads.get(session), live = true;
    if (!read) { countryReads.set(session, read = readCountries(sessionContext(session))); read.catch(() => countryReads.delete(session)); }
    read.then(list => { if (live) setCountries(list); }, () => { if (live) setCountries(undefined); });
    return () => { live = false; };
  }, [session, wanted]);
  return countries;
}
/** The tax_zone_mismatch rescue: deletes that one order's addresses in the till's own outbox (pos_orders, never replicated), then requeues it. */
export async function sendWithoutAddress(orders: RxCollection<PosOrder> | null, requeue: Requeue, orderId: string): Promise<boolean> {
  const doc = await orders?.findOne(orderId).exec(); let modified = false;
  await doc?.incrementalModify(data => {
    if (!canSendWithoutAddress(data) || !data.customer) return data;
    const { billing: _billing, shipping: _shipping, ...customer } = data.customer; modified = true;
    return { ...data, customer };
  });
  return modified && (await requeue([orderId])) > 0;
}
/** Retry for every till path: a tax_zone_mismatch order goes without its address, so no Retry loops on the same refusal. */
export const retryOrders = (orders: RxCollection<PosOrder> | null, requeue: Requeue) => async (orderIds: string[]): Promise<number> => {
  const rest: string[] = []; let sent = 0;
  for (const id of orderIds) {
    const doc = await orders?.findOne(id).exec();
    if (doc && canSendWithoutAddress(doc)) sent += Number(await sendWithoutAddress(orders, requeue, id)); else rest.push(id);
  }
  return sent + (rest.length ? await requeue(rest) : 0);
};
