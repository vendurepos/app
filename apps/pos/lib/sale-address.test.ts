import { describe, expect, it, vi } from 'vitest';
import type { PosOrder } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { ADDRESS_PARTS, CUSTOMER_ADDRESS_REQUIRED_TEXT } from './customer-edit';
import {
  ADDRESS_PART_TOO_LONG_TEXT, addressBlocked, addressCopy, parseTaxZone, retryOrders, saleAddresses, sendWithoutAddress, shouldPrefill,
} from './sale-address';

describe('parseTaxZone (u1)', () => {
  it('accepts byAddress and a list of country codes', () => {
    expect(parseTaxZone({ byAddress: false, countries: ['DE'] })).toEqual({ byAddress: false, countries: ['DE'] });
  });
  it.each([
    ['a missing field', { byAddress: true }],
    ['a non-boolean byAddress', { byAddress: 'yes', countries: ['DE'] }],
    ['a non-array countries', { byAddress: true, countries: 'DE' }],
    ['a non-string country', { byAddress: true, countries: ['DE', 7] }],
    ['no taxZone at all', undefined],
  ])('is undefined for %s', (_, value) => {
    expect(parseTaxZone(value)).toBeUndefined();
  });
});

describe('addressBlocked (u2)', () => {
  const DE = { address1: '1 Str', country: 'DE' }, DK = { address1: '2 Vej', country: 'DK' };
  const byAddress = { byAddress: true, countries: ['DE'] };
  it.each([
    ['byAddress false, outside the zone', { byAddress: false, countries: ['DE'] }, DK, DK, false],
    ['byAddress true, both inside', byAddress, DE, DE, false],
    ['billing outside', byAddress, DK, DE, true],
    ['shipping outside', byAddress, DE, DK, true],
    ['no address', byAddress, undefined, undefined, false],
    ['taxZone undefined', undefined, DK, DK, false],
  ] as const)('%s', (_, zone, billing, shipping, blocked) => {
    expect(addressBlocked(zone && { ...zone, countries: [...zone.countries] }, billing, shipping)).toBe(blocked);
  });
});

describe('shouldPrefill (u3)', () => {
  const facts = { key: 'order|customer', seen: null, cart: true, hasAddress: false, orderCreate: 11, taxZone: { byAddress: false, countries: ['DE'] } };
  it('prefills when every fact holds', () => expect(shouldPrefill(facts)).toBe(true));
  it.each([
    ['taxZone undefined', { taxZone: undefined }],
    ['orderCreate 10', { orderCreate: 10 }],
    ['the same order and customer seen before', { seen: 'order|customer' }],
    ['an address already on the sale', { hasAddress: true }],
    ['outside the cart', { cart: false }],
    ['no customer', { key: null }],
  ])('does not with %s', (_, change) => {
    expect(shouldPrefill({ ...facts, ...change })).toBe(false);
  });
});

describe('address copy and save (u4)', () => {
  const full = Object.fromEntries(ADDRESS_PARTS.map(part => [part, `${part} value`]));
  it('keeps exactly ADDRESS_PARTS, dropping email and empty parts', () => {
    expect(addressCopy({ ...full, email: 'a@example.com' } as never)).toEqual(full);
    expect(addressCopy({ address1: '1 Str', country: 'DK', company: '', address2: '  ' })).toEqual({ address1: '1 Str', country: 'DK' });
    expect(addressCopy({ email: 'a@example.com' } as never)).toBeUndefined();
  });
  it('saves billing with shipping undefined for "Same as billing"', () => {
    expect(saleAddresses({ billing: { address1: '1 Str', country: 'DK' } })).toEqual({ billing: { address1: '1 Str', country: 'DK' }, shipping: undefined });
  });
  it.each([
    ['a missing address1', { billing: { city: 'Aarhus', country: 'DK' } }, CUSTOMER_ADDRESS_REQUIRED_TEXT],
    ['a missing country', { shipping: { address1: '1 Str' } }, CUSTOMER_ADDRESS_REQUIRED_TEXT],
    ['a 256-character part', { billing: { address1: '1 Str', country: 'DK', city: 'x'.repeat(256) } }, ADDRESS_PART_TOO_LONG_TEXT],
  ])('refuses %s', (_, value, error) => {
    expect(saleAddresses(value)).toEqual({ error });
  });
  it('takes a 255-character part', () => {
    expect(saleAddresses({ billing: { address1: '1 Str', country: 'DK', city: 'x'.repeat(255) } })).not.toHaveProperty('error');
  });
});

describe('sendWithoutAddress (u5)', () => {
  const customer = { id: 'c1', name: 'Dana', email: 'd@example.com', billing: { address1: '2 Vej', country: 'DK' }, shipping: { address1: '3 Vej', country: 'DK' }, taxIds: [] };
  const order = (fields: Partial<PosOrder>) => ({
    id: 'o1', saleId: 'o1', createdAt: '2026-11-24T10:00:00Z', commandId: 'cmd-o1', lines: [{ sku: 'MUG' }], customer, ...fields,
  }) as unknown as PosOrder;
  // A pos_orders stand-in: findOne(id).exec() and incrementalModify, as RxDB runs them.
  const collection = (docs: PosOrder[]) => {
    const data = new Map(docs.map(doc => [doc.id, structuredClone(doc)]));
    const docOf = (id: string) => {
      const current = data.get(id);
      return current && Object.assign(structuredClone(current), {
        incrementalModify: async (fn: (d: PosOrder) => PosOrder) => { data.set(id, fn(structuredClone(data.get(id)!))); },
      });
    };
    return { data, orders: { findOne: (id: string) => ({ exec: async () => docOf(id) ?? null }) } as unknown as RxCollection<PosOrder> };
  };
  const zone = { syncStatus: 'rejected', error: { code: 'tax_zone_mismatch', message: 'zone' } } as const;

  it('deletes both addresses of a tax_zone_mismatch refusal, keeps the rest, and requeues that order', async () => {
    const before = order(zone), other = order({ ...zone, id: 'o2' });
    const { data, orders } = collection([before, other]);
    const requeue = vi.fn(async () => 1);
    expect(await sendWithoutAddress(orders, requeue, 'o1')).toBe(true);
    const { billing: _b, shipping: _s, ...rest } = customer;
    expect(data.get('o1')).toEqual({ ...before, customer: rest });
    expect(data.get('o2')).toEqual(other);
    expect(requeue).toHaveBeenCalledWith(['o1']);
  });

  it.each([
    ['another code', order({ syncStatus: 'rejected', error: { code: 'invalid_payload', message: 'x' } })],
    ['a pending order', order({ syncStatus: 'pending' })],
  ])('leaves %s unchanged and unsent', async (_, before) => {
    const { data, orders } = collection([before]);
    const requeue = vi.fn(async () => 1);
    expect(await sendWithoutAddress(orders, requeue, 'o1')).toBe(false);
    expect(data.get('o1')).toEqual(before);
    expect(requeue).not.toHaveBeenCalled();
  });

  it('retryOrders sends the tax_zone_mismatch order without its address and requeues the rest as they are', async () => {
    const plain = order({ id: 'o2', syncStatus: 'rejected', error: { code: 'invalid_payload', message: 'x' } });
    const { data, orders } = collection([order(zone), plain]);
    const requeue = vi.fn(async (ids: string[]) => ids.length);
    expect(await retryOrders(orders, requeue)(['o1', 'o2'])).toBe(2);
    expect(requeue.mock.calls).toEqual([[['o1']], [['o2']]]);
    expect(data.get('o1')?.customer).not.toHaveProperty('shipping');
    expect(data.get('o2')).toEqual(plain);
  });
});
