import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVendureConnector } from '@tallyui/connector-vendure';
import { defaultPaymentMethods, wireMethodOf, type Customer, type StoreSettings } from '@tallyui/core';
import { addEntryToCart, catalogueEntries, createOrderBuilder, finalizeOrder, TaxProvider, taxProviderProps, toOrderCreateEnvelope, useTax, type TaxContext, type TaxProviderProps } from '@tallyui/pos';
import { createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { loadDefaultCustomer, saveDefaultCustomer } from './default-customer';
import type { KeyValueStore } from './session';

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

/** A cash and a card leg from the default tiles, as TenderPane's tenderOf builds them (not exported by @tallyui/components). */
function envelope() {
  const items = new Map<string, string>();
  const store: KeyValueStore = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: (key) => { items.delete(key); } };
  const session = { url: 'https://store.example', channelToken: 'default' };
  saveDefaultCustomer(session, customer, store);
  const traits = createVendureConnector({ pricesIncludeTax: false }).traits.product;
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: saleTaxContext() });
  addEntryToCart(builder, catalogueEntries(products, traits)[0], traits, 'EUR');
  builder.setCustomer(loadDefaultCustomer(session, store));
  const [cash, card] = defaultPaymentMethods();
  const total = builder.getSnapshot().totalMinor;
  for (const [tile, amountMinor] of [[cash, 500], [card, total - 500]] as const) {
    const method = wireMethodOf(tile);
    builder.addPayment({ method, ...(tile.id !== method ? { methodId: tile.id } : {}), amountMinor });
  }
  // useSale's finalize options, as app/index.tsx sets them: no taxContextFor, so no taxLocation.
  const order = finalizeOrder(builder.getSnapshot(), { registerId: 'register-1', cashierRef: 'cashier', capabilities: { orderCreate: 10, register: 3 } });
  return toOrderCreateEnvelope(order, 'device-1', 1, { maxVersion: 10 });
}

it('at order.create cap 10 a sale with an addressed customer sends no taxAddress, billing, shipping or coupons', () => {
  const sent = envelope();
  expect(sent.version).toBeLessThanOrEqual(7);
  expect(sent.payload).not.toHaveProperty('taxAddress');
  expect(sent.payload.customer).toMatchObject({ customerId: 'C1' });
  expect(sent.payload.customer).not.toHaveProperty('billing');
  expect(sent.payload.customer).not.toHaveProperty('shipping');
  expect(sent.payload.coupons ?? []).toEqual([]);
  // The useSale options are inline in app/index.tsx: no tax-by-address hook and no sale addresses.
  expect(readFileSync(fileURLToPath(new URL('../app/index.tsx', import.meta.url).href), 'utf8')).not.toMatch(/taxContextFor|setAddresses/);
});

it('the default Cash and Card tiles send no payments[].methodId', () => {
  const { payments } = envelope().payload;
  expect(defaultPaymentMethods().map((tile) => [tile.id, wireMethodOf(tile)])).toEqual([['cash', 'cash'], ['external', 'external']]);
  expect(payments.map((payment) => payment.method)).toEqual(['cash', 'external']);
  for (const payment of payments) expect(payment).not.toHaveProperty('methodId');
});
