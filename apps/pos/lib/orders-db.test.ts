import type { SyncNotice } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, OrderContentMismatchError, type PosOrder } from '@tallyui/pos';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { Subject } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { catalogueConnector, databaseName, removeCatalogueDatabaseWithin, startCatalogueSync } from './catalogue';
import { isOrderStored, openOrders, ORDERS_DATABASE_NAME, recordOrder } from './orders-db';
import type { Session } from './session';

// Memory storage stands in for SQLite: like the web engine, one storage serves both databases, each under its own name.
vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
// The catalogue database is created for real; only the network-facing sync is stubbed (as in catalogue.test.ts).
vi.mock('@tallyui/database', async (importActual) => ({
  ...await importActual<typeof import('@tallyui/database')>(),
  startStockReconcile: vi.fn(() => ({ reconcileStock: vi.fn(async () => ({})), stop: vi.fn() })),
  startIdReconcile: vi.fn(() => ({ reconcileIds: vi.fn(async () => ({})), stop: vi.fn() })),
  startFingerprintReconcile: vi.fn(() => ({ reconcile: vi.fn(async () => ({})), stop: vi.fn() })),
  startReplication: vi.fn(() => ({
    cancel: vi.fn(async () => {}), reSync: vi.fn(),
    active$: new Subject<boolean>(), error$: new Subject<Error>(), received$: new Subject(),
    notice$: new Subject<SyncNotice | undefined>(), resume: vi.fn(async () => {}),
  })),
}));

const session: Session = {
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'test-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};

/** A cash sale of one mug at 8.00 + 19 %, paid with 10.00, finalized as useSale.complete() does. */
function cashSale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { getTaxRatePpm: () => 190000, pricesIncludeTax: false } });
  builder.addLine({ productId: 'mug', variantId: '11', name: 'Tally Fixture Mug', sku: 'TALLY-MUG', unitPrice: { amount: 800, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1000 });
  return finalizeOrder(builder.getSnapshot(), { registerId: 'register-1', cashierRef: session.email });
}

it('keeps its own database, apart from every catalogue database name', () => {
  expect(ORDERS_DATABASE_NAME).not.toBe(databaseName(session));
  expect(ORDERS_DATABASE_NAME).not.toMatch(/^vendurepos_[0-9a-f]{8}$/);
});

it('stores a completed sale and confirms it with isStored', async () => {
  const order = cashSale();
  expect(await isOrderStored(order)).toBe(false);
  await recordOrder(order);
  expect(await isOrderStored(order)).toBe(true);
  const stored = await (await openOrders()).findOne(order.id).exec();
  expect(stored?.toJSON()).toMatchObject({ id: order.id, syncStatus: 'pending', totalMinor: 952 });
  expect(stored?.payments).toEqual([expect.objectContaining({ method: 'cash', amountMinor: 952, tenderedMinor: 1000, changeMinor: 48 })]);
});

it("counts a retried complete()'s same order as stored, and refuses other content under its id", async () => {
  const order = cashSale();
  await recordOrder(order);
  await expect(recordOrder(order)).resolves.toBeUndefined();
  const other = { ...order, totalMinor: order.totalMinor + 1 };
  await expect(recordOrder(other)).rejects.toBeInstanceOf(OrderContentMismatchError);
  expect(await isOrderStored(other)).toBe(false);
  expect(await isOrderStored(order)).toBe(true);
});

it('still holds a stored order after sign-out removes the catalogue database', async () => {
  await startCatalogueSync(session, catalogueConnector(session));
  const order = cashSale();
  await recordOrder(order);
  expect(await removeCatalogueDatabaseWithin()).toBe('removed');
  expect(await isOrderStored(order)).toBe(true);
  const orders = await openOrders();
  expect(orders.closed).toBe(false);
  expect((await orders.findOne(order.id).exec())?.id).toBe(order.id);
  // Signing in again reopens the catalogue under the same name; the order is still there.
  await startCatalogueSync(session, catalogueConnector(session));
  expect(await isOrderStored(order)).toBe(true);
  expect(await removeCatalogueDatabaseWithin()).toBe('removed');
  // The open handle keeps a removed memory store's documents, so read the order back as a reload would: the
  // database closed (memory storage keeps its data on close, never on remove), the module fresh, the store reopened.
  await orders.database.close();
  vi.resetModules();
  const reloaded = await import('./orders-db');
  expect(await reloaded.isOrderStored(order)).toBe(true);
  expect((await (await reloaded.openOrders()).findOne(order.id).exec())?.syncStatus).toBe('pending');
});
