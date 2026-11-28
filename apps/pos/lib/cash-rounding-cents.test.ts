// @vitest-environment happy-dom
import { createVendureConnector } from '@tallyui/connector-vendure';
import type { ServerCapabilities, SyncContext } from '@tallyui/core';
import { catalogueEntries, createOrderBuilder, finalizeOrder, TaxProvider, taxProviderProps, tenderRounding, toOrderCreateEnvelope, useSale } from '@tallyui/pos';
import { act, createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { createRoot } from 'react-dom/client';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogueConnector } from './catalogue';
import type { Session } from './session';
import { parseTenderMethods } from './tender-methods';

const { original } = vi.hoisted(() => ({ original: vi.fn<(context: SyncContext) => Promise<ServerCapabilities | undefined>>() }));
vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
vi.mock('@tallyui/connector-vendure', async (importActual) => {
  const actual = await importActual<typeof import('@tallyui/connector-vendure')>();
  return { ...actual, createVendureConnector: (options: Parameters<typeof actual.createVendureConnector>[0]) => ({ ...actual.createVendureConnector(options), capabilities: original }) };
});

const session: Session = {
  url: 'https://shop.example.com', email: 'till@example.com', token: 'session-token', channelToken: 'channel-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 0 } },
  stock: { trackInventory: false, outOfStockThreshold: 0 },
};
const context: SyncContext = { connectorId: 'vendure', baseUrl: 'https://shop.example.com', headers: { Authorization: 'Bearer session-token' }, signal: new AbortController().signal };
const INFO = {
  contracts: { 'order.create': [1, 10, 11], 'order.refund': [1], register: [1] },
  taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
  coupons: true,
};
const fetchMock = vi.fn<typeof fetch>();
const read = () => catalogueConnector(session).capabilities!(context);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: { render(node: unknown): void; unmount(): void };
beforeEach(() => {
  root = createRoot(document.createElement('div'));
  fetchMock.mockReset();
  original.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function takeCash(capabilities: ServerCapabilities, mode: 'nearest' | 'down' | undefined, handedMinor: number) {
  const settings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000, '1': 190000 }, taxRounding: capabilities.taxRounding };
  let sale!: ReturnType<typeof useSale>;
  let completed!: ReturnType<typeof finalizeOrder>;
  function Till() {
    sale = useSale(settings, { registerId: 'register-1', cashierRef: 'cashier@example.com', capabilities, onSaleCompleted: (order) => { completed = order; } });
    return null;
  }
  await act(async () => root.render(createElement(TaxProvider, taxProviderProps(settings) as Parameters<typeof TaxProvider>[0], createElement(Till))));
  const traits = createVendureConnector({ pricesIncludeTax: false }).traits.product;
  const products = [{ id: 'mug', name: 'Tally Fixture Mug', variants: [{ id: '11', name: 'Tally Fixture Mug', sku: 'TALLY-MUG', price: 800, currencyCode: 'EUR', enabled: true, trackInventory: 'FALSE', taxCategory: { id: '1' } }] }];
  await act(async () => { sale.add(catalogueEntries(products, traits)[0], traits); });
  await act(async () => { sale.addFee({ name: 'Service', amountMinor: 100 }); });
  await act(async () => { sale.addShipping({ name: 'Courier', amountMinor: 200 }); });
  expect(sale.order.totalMinor).toBe(1309);
  const beforeTax = sale.order.taxMinor;
  await act(async () => { sale.startTender('cash'); });
  const cash = parseTenderMethods({ paymentMethods: [{ code: 'cash', name: 'Cash', kind: 'cash', ...(mode ? { rounding: { incrementMinor: 5, mode } } : {}) }] }, 11)![0];
  await act(async () => {
    expect(sale.addTender({ method: 'cash', methodId: cash.id, amountMinor: handedMinor, rounding: cash.defaults.rounding })).toBeTypeOf('string');
  });
  expect(sale.error).toBeNull();
  await act(async () => { await sale.complete(); });
  return { beforeTax, live: sale.order, order: completed };
}

function roundedSale(mode: 'nearest' | 'down', tenderedMinor: number) {
  const cash = parseTenderMethods({ paymentMethods: [{ code: 'cash', name: 'Cash', kind: 'cash', rounding: { incrementMinor: 5, mode } }] }, 11)![0];
  const taxContext = { getTaxRatePpm: () => 190000, pricesIncludeTax: false };
  const builder = createOrderBuilder({ currency: 'EUR', taxContext });
  builder.addLine({ productId: 'mug', variantId: '11', name: 'Tally Fixture Mug', sku: 'TALLY-MUG', unitPrice: { amount: 800, currency: 'EUR' } });
  builder.addFee({ name: 'Service', amountMinor: 100 });
  builder.addShipping({ name: 'Courier', amountMinor: 200 });
  const before = builder.getSnapshot();
  expect(before.totalMinor).toBe(1309);
  const leg = tenderRounding({ entryMinor: 1309, entryDirty: false }, 1309, cash);
  builder.addPayment({ method: 'cash', methodId: cash.id, amountMinor: leg.appliedMinor, tenderedMinor },
    leg.roundingMinor !== 0 ? { minor: leg.roundingMinor } : undefined);
  return builder.getSnapshot();
}

it.each([
  { name: 'R1: nearest at 5 settles a 13.09 sale at 13.10: rounding +1, change from 20.00 is 6.90', mode: 'nearest', total: 1310, rounding: 1, tendered: 2000, change: 690 },
  { name: 'R2: down at 5 settles a 13.09 sale at 13.05: rounding -4', mode: 'down', total: 1305, rounding: -4, tendered: 1305, change: 0 },
] as const)('$name', async ({ mode, total, rounding, tendered, change }) => {
  fetchMock.mockResolvedValue(Response.json({ ...INFO, cashRounding: { v: 1 } }));
  const capabilities = await read();
  expect(capabilities?.cashRounding).toBe(true);
  expect(capabilities?.taxRounding).toEqual({ granularity: 'per_rate_group_items', mode: 'half_up' });
  const { beforeTax, live, order } = await takeCash(capabilities!, mode, tendered);
  const leg = { method: 'cash', methodId: 'cash', amountMinor: total, tenderedMinor: tendered, changeMinor: change };
  for (const snapshot of [live, order]) {
    expect(snapshot.payments.map(({ method, methodId, amountMinor, tenderedMinor, changeMinor }) => ({ method, methodId, amountMinor, tenderedMinor, changeMinor }))).toEqual([leg]);
    expect(snapshot.cashRoundings).toEqual([{ paymentId: snapshot.payments[0].id, minor: rounding }]);
    expect(snapshot.totalMinor).toBe(total);
  }
  expect(order.taxMinor).toBe(beforeTax);
  expect(capabilities?.orderCreate).toBe(11);
  const { payload } = toOrderCreateEnvelope(order, 'device-1', 1, { maxVersion: capabilities!.orderCreate });
  expect(payload.totalMinor).toBe(total);
  expect(payload.cashRoundings).toEqual([{ paymentId: order.payments[0].id, minor: rounding }]);
  expect(payload.payments).toEqual([{ clientPaymentId: order.payments[0].id, ...leg }]);
});

it('R3: without cashRounding on /info, the till takes 13.09 unrounded: change from 20.00 is 6.91', async () => {
  fetchMock.mockResolvedValue(Response.json(INFO));
  const capabilities = await read();
  expect(capabilities).not.toHaveProperty('cashRounding');
  const { order } = await takeCash(capabilities!, 'nearest', 2000);
  const leg = { method: 'cash', methodId: 'cash', amountMinor: 1309, tenderedMinor: 2000, changeMinor: 691 };
  expect(order.payments.map(({ method, methodId, amountMinor, tenderedMinor, changeMinor }) => ({ method, methodId, amountMinor, tenderedMinor, changeMinor }))).toEqual([leg]);
  expect(order.totalMinor).toBe(1309);
  expect(capabilities?.orderCreate).toBe(11);
  const { payload } = toOrderCreateEnvelope(order, 'device-1', 1, { maxVersion: capabilities!.orderCreate });
  expect(payload).not.toHaveProperty('cashRoundings');
  expect(payload.payments).toEqual([{ clientPaymentId: order.payments[0].id, ...leg }]);
});

it('R4: without cashRounding on /info, finalize refuses a hand-built rounded sale', async () => {
  fetchMock.mockResolvedValue(Response.json(INFO));
  const capabilities = await read();
  expect(capabilities).not.toHaveProperty('cashRounding');
  const snapshot = roundedSale('nearest', 2000);
  expect(() => finalizeOrder(snapshot, { registerId: 'register-1', cashierRef: 'cashier@example.com', capabilities }))
    .toThrow('finalize: cash rounding needs a store whose connector declares the cashRounding capability');
});
