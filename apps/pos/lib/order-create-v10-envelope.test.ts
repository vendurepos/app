import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVendureConnector } from '@tallyui/connector-vendure';
import { defaultPaymentMethods, wireMethodOf, type Customer, type PaymentMethodDescriptor, type StoreSettings } from '@tallyui/core';
import { addEntryToCart, catalogueEntries, createOrderBuilder, finalizeOrder, TaxProvider, taxProviderProps, toOrderCreateEnvelope, useTax, type TaxContext, type TaxProviderProps } from '@tallyui/pos';
import { createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DEMO_INFO } from './demo/store';
import { loadDefaultCustomer, saveDefaultCustomer } from './default-customer';
import type { KeyValueStore } from './session';
import { parseTenderMethods } from './tender-methods';

// 3.2a-1 (desk addendum, condition 2): the plugin refuses v8 taxAddress and customer addresses and v9 coupon lines, so
// the app must never send them. The real builder, finalizeOrder and envelope at the plugin's cap of 10; the app's own
// customer mapping (the default customer, set on every new cart) and its default tiles (TenderPane with no `methods`).
const settings: StoreSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190_000, '1': 190_000 },
  taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' }, taxRateCodes: { default: 'Standard DE', '1': 'Standard DE' },
};
const products = [{ id: 'mug', name: 'Mug', variants: [{ id: '11', name: 'Mug', sku: 'MUG', price: 800, currencyCode: 'EUR', enabled: true, trackInventory: 'FALSE', taxCategory: { id: '1' } }] }];
const address = (city: string) => ({ firstName: 'Ada', lastName: 'Lovelace', address1: '1 Main St', city, postcode: '10115', country: 'DE' });
const customer: Customer = { id: 'C1', name: 'Ada Lovelace', email: 'ada@example.com', billing: address('Berlin'), shipping: address('Hamburg') };

function saleTaxContext(): TaxContext {
  let context: TaxContext | undefined;
  const Probe = () => { context = useTax(); return null; };
  renderToString(createElement(TaxProvider, taxProviderProps(settings) as TaxProviderProps, createElement(Probe)));
  return context!;
}

/**
 * A cash leg and one other leg from two tiles (the default Cash and Card unless given), as TenderPane's tenderOf builds
 * them (not exported by @tallyui/components). The customer comes from the stored default customer, or straight from
 * `builder.setCustomer` with `direct`.
 */
function envelope({ tiles = defaultPaymentMethods(), direct = false }: { tiles?: PaymentMethodDescriptor[]; direct?: boolean } = {}) {
  const items = new Map<string, string>();
  const store: KeyValueStore = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: (key) => { items.delete(key); } };
  const session = { url: 'https://store.example', channelToken: 'default' };
  saveDefaultCustomer(session, customer, store);
  const traits = createVendureConnector({ pricesIncludeTax: false }).traits.product;
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: saleTaxContext() });
  addEntryToCart(builder, catalogueEntries(products, traits)[0], traits, 'EUR');
  builder.setCustomer(direct ? customer : loadDefaultCustomer(session, store));
  const [cash, card] = tiles;
  const total = builder.getSnapshot().totalMinor;
  for (const [tile, amountMinor] of [[cash, 500], [card, total - 500]] as const) {
    const method = wireMethodOf(tile);
    builder.addPayment({ method, ...(tile.id !== method ? { methodId: tile.id } : {}), amountMinor });
  }
  // useSale's finalize options, as app/index.tsx sets them: no taxContextFor, so no taxLocation.
  const order = finalizeOrder(builder.getSnapshot(), { registerId: 'register-1', cashierRef: 'cashier', capabilities: { orderCreate: 10, register: 3 } });
  return toOrderCreateEnvelope(order, 'device-1', 1, { maxVersion: 10 });
}

/** Every non-test .ts/.tsx file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(join(dir, entry.name))
    : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [join(dir, entry.name)] : []);
}

function expectNoAddressFields(sent: ReturnType<typeof envelope>) {
  expect(sent.payload).not.toHaveProperty('taxAddress');
  expect(sent.payload.customer).toMatchObject({ customerId: 'C1' });
  expect(sent.payload.customer).not.toHaveProperty('billing');
  expect(sent.payload.customer).not.toHaveProperty('shipping');
  expect(sent.payload.coupons ?? []).toEqual([]);
}

it.each([['the stored default customer', false], ['builder.setCustomer directly', true]])(
  'at order.create cap 10 a sale with an addressed customer from %s sends no taxAddress, billing, shipping or coupons', (_, direct) => {
    const sent = envelope({ direct });
    expect(sent.version).toBeLessThanOrEqual(7);
    expectNoAddressFields(sent);
  });

it('no app or lib source sets a tax-by-address hook, and only the 5.2a pin sets sale addresses', () => {
  // A source check: useSale's options are inline in app/index.tsx, and a spread-in from any other file is caught too.
  const root = fileURLToPath(new URL('..', import.meta.url).href);
  const files = ['../app', '.'].flatMap((dir) => sources(fileURLToPath(new URL(dir, import.meta.url).href)));
  expect(files.some((file) => file.endsWith(join('app', 'index.tsx')))).toBe(true);
  expect(files.filter((file) => /taxContextFor/.test(readFileSync(file, 'utf8')))).toEqual([]);
  // The 5.2a address pin, gated on order.create >= 11, is the only caller of setAddresses.
  expect(files.filter((file) => /setAddresses/.test(readFileSync(file, 'utf8'))).map((file) => relative(root, file)).sort())
    .toEqual([join('lib', 'sale-address.ts'), join('lib', 'sale-customer.tsx')]);
});

it("the merchant's tiles at cap 10 send v10 with the voucher's methodId, and still no addresses or coupons", () => {
  const tiles = parseTenderMethods(DEMO_INFO, 10)!;
  const sent = envelope({ tiles: [tiles.find((tile) => tile.id === 'cash')!, tiles.find((tile) => tile.id === 'voucher')!] });
  expect(sent.version).toBe(10);
  const [cash, voucher] = sent.payload.payments;
  expect(voucher).toMatchObject({ method: 'external', methodId: 'voucher' });
  expect(cash.method).toBe('cash');
  expect(cash).not.toHaveProperty('methodId');
  expectNoAddressFields(sent);
});

it('the default Cash and Card tiles send no payments[].methodId', () => {
  const { payments } = envelope().payload;
  expect(defaultPaymentMethods().map((tile) => [tile.id, wireMethodOf(tile)])).toEqual([['cash', 'cash'], ['external', 'external']]);
  expect(payments.map((payment) => payment.method)).toEqual(['cash', 'external']);
  for (const payment of payments) expect(payment).not.toHaveProperty('methodId');
});
