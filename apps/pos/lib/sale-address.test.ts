import { describe, expect, it, vi } from 'vitest';
import type { PosOrder } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { ADDRESS_PARTS, CUSTOMER_ADDRESS_REQUIRED_TEXT } from './customer-edit';
import {
  ADDRESS_PART_TOO_LONG_TEXT, ADDRESS_ZONE_BLOCK_TEXT, addressBlocked, addressCopy, beginCheckout, claimPrefill, lateReadApplies, parseTaxZone, retryOrders, saleAddresses, sendWithoutAddress,
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
    ['byAddress false, outside the zone', { byAddress: false, countries: ['DE'] }, 11, DK, DK, false],
    ['byAddress true, both inside', byAddress, 11, DE, DE, false],
    ['billing outside', byAddress, 11, DK, DE, true],
    ['shipping outside', byAddress, 11, DE, DK, true],
    ['no address', byAddress, 11, undefined, undefined, false],
    ['taxZone undefined', undefined, 11, DK, DK, false],
    ['orderCreate 10, outside the zone', byAddress, 10, DK, DK, false],
    ['orderCreate undefined, outside the zone', byAddress, undefined, DK, DK, false],
  ] as const)('%s', (_, zone, orderCreate, billing, shipping, blocked) => {
    expect(addressBlocked(zone && { ...zone, countries: [...zone.countries] }, orderCreate, billing, shipping)).toBe(blocked);
  });
});

describe('beginCheckout (u8)', () => {
  const run = async (blocked: boolean) => {
    const calls: unknown[][] = [];
    await beginCheckout({
      settle: () => { calls.push(['settle']); }, blocked,
      start: async () => { calls.push(['start']); return 'tender refused'; },
      setError: (error) => { calls.push(['setError', error]); },
    });
    return calls;
  };
  it('refuses a blocked sale after settling, and never starts a tender', async () => {
    expect(await run(true)).toEqual([['settle'], ['setError', ADDRESS_ZONE_BLOCK_TEXT]]);
  });
  it('settles, clears the error, starts the tender and shows its result', async () => {
    expect(await run(false)).toEqual([['settle'], ['setError', undefined], ['start'], ['setError', 'tender refused']]);
  });
});

describe('claimPrefill (u3)', () => {
  const facts = { key: 'order|customer', cart: true, hasAddress: false, orderCreate: 11, taxZone: { byAddress: false, countries: ['DE'] } };
  it('prefills when every fact holds, and claims the key', () => {
    const seen = new Set<string>();
    expect(claimPrefill(seen, facts)).toBe(true);
    expect(seen).toEqual(new Set(['order|customer']));
  });
  it.each([
    ['taxZone undefined', { taxZone: undefined }],
    ['orderCreate 10', { orderCreate: 10 }],
    ['outside the cart', { cart: false }],
    ['no customer', { key: null }],
  ])('does not with %s', (_, change) => {
    const seen = new Set<string>();
    expect(claimPrefill(seen, { ...facts, ...change })).toBe(false);
    expect(seen.size).toBe(0);
  });
  it('does not with the same order and customer seen before', () => {
    expect(claimPrefill(new Set(['order|customer']), facts)).toBe(false);
  });
  it('never refills a sale switched away from and back to', () => {
    const seen = new Set<string>();
    expect([claimPrefill(seen, { ...facts, key: 'A|X' }), claimPrefill(seen, { ...facts, key: 'B|Y' }), claimPrefill(seen, { ...facts, key: 'A|X' })]).toEqual([true, true, false]);
  });
  it('lets an address already on the sale use up the key, so a later Remove is not refilled', () => {
    const seen = new Set<string>();
    expect(claimPrefill(seen, { ...facts, hasAddress: true })).toBe(false);
    expect(claimPrefill(seen, facts)).toBe(false);
  });
});

describe('lateReadApplies (u7)', () => {
  const now = { order: { id: 'A', customer: { id: 'X' } }, stage: { kind: 'cart' } } as unknown as Parameters<typeof lateReadApplies>[0]['now'];
  const facts = { settled: new Set<string>(), key: 'A|X', now, orderId: 'A', customerId: 'X' };
  it('applies to the same untouched cart', () => expect(lateReadApplies(facts)).toBe(true));
  it.each([
    ['the key settled at Checkout', { settled: new Set(['A|X']) }],
    ['a different order', { orderId: 'B' }],
    ['a different customer', { customerId: 'Y' }],
    ['a sale no longer in the cart', { now: { ...now, stage: { kind: 'tender' } } as typeof now }],
    ['an address already pinned', { now: { ...now, order: { ...now.order, customer: { id: 'X', shipping: { address1: '1 Str', country: 'DE' } } } } as typeof now }],
  ])('does not with %s', (_, change) => {
    expect(lateReadApplies({ ...facts, ...change })).toBe(false);
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
