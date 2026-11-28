import type { ServerCapabilities, SyncContext } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, tenderRounding, toOrderCreateEnvelope } from '@tallyui/pos';
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

beforeEach(() => {
  fetchMock.mockReset();
  original.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  return { before, leg, snapshot: builder.getSnapshot() };
}

it.each([
  { name: 'R1: nearest at 5 settles a 13.09 sale at 13.10: rounding +1, change from 20.00 is 6.90', mode: 'nearest', total: 1310, rounding: 1, tendered: 2000, change: 690 },
  { name: 'R2: down at 5 settles a 13.09 sale at 13.05: rounding -4', mode: 'down', total: 1305, rounding: -4, tendered: 1305, change: 0 },
] as const)('$name', async ({ mode, total, rounding, tendered, change }) => {
  fetchMock.mockResolvedValue(Response.json({ ...INFO, cashRounding: { v: 1 } }));
  const capabilities = await read();
  expect(capabilities?.cashRounding).toBe(true);
  const { before, leg, snapshot } = roundedSale(mode, tendered);
  expect(leg).toEqual({ roundedDueMinor: total, roundingMinor: rounding, entryMinor: total, appliedMinor: total });
  expect(snapshot.totalMinor).toBe(total);
  expect(snapshot.cashRoundings).toEqual([{ paymentId: snapshot.payments[0].id, minor: rounding }]);
  const order = finalizeOrder(snapshot, { registerId: 'register-1', cashierRef: 'cashier@example.com', capabilities });
  expect(order.totalMinor).toBe(total);
  expect(order.taxMinor).toBe(before.taxMinor);
  const [payment] = order.payments;
  expect(payment.amountMinor).toBe(total);
  expect(payment.tenderedMinor).toBe(tendered);
  expect(payment.changeMinor ?? (payment.tenderedMinor! - payment.amountMinor)).toBe(change);
  const cashRoundings = [{ paymentId: payment.id, minor: rounding }];
  expect(order.cashRoundings).toEqual(cashRoundings);
  const { payload } = toOrderCreateEnvelope(order, 'device-1');
  expect(payload.totalMinor).toBe(total);
  expect(payload.cashRoundings).toEqual(cashRoundings);
});

it('R3: without cashRounding on /info, finalize refuses the rounded sale', async () => {
  fetchMock.mockResolvedValue(Response.json(INFO));
  const capabilities = await read();
  expect(capabilities).not.toHaveProperty('cashRounding');
  const { snapshot } = roundedSale('nearest', 2000);
  expect(() => finalizeOrder(snapshot, { registerId: 'register-1', cashierRef: 'cashier@example.com', capabilities }))
    .toThrow('finalize: cash rounding needs a store whose connector declares the cashRounding capability');
});
