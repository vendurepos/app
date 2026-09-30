import type { SyncNotice } from '@tallyui/core';
import {
  createOrderBuilder, finalizeOrder, openSession, readRegister, reconcileRegisterCommands, recordMovement, type PosOrder,
} from '@tallyui/pos';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { Subject } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { catalogueConnector, databaseName, removeCatalogueDatabaseWithin, startCatalogueSync } from './catalogue';
import { openOrderStore, ordersDatabaseName, outboxStoreKey, registerCollections, type OrderStore } from './orders-db';
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
// ensureRegister's platform, stamped on the register document.
const PLATFORM = 'web';
// Another channel of the same server: a store of its own for orders.
const otherStore: OrderStore = { url: session.url, channelToken: 'channel-b-token' };

/** A cash sale of one mug at 8.00 + 19 %, paid with 10.00, finalized as useSale.complete() does. */
function cashSale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { getTaxRatePpm: () => 190000, pricesIncludeTax: false } });
  builder.addLine({ productId: 'mug', variantId: '11', name: 'Tally Fixture Mug', sku: 'TALLY-MUG', unitPrice: { amount: 800, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1000 });
  return finalizeOrder(builder.getSnapshot(), { registerId: 'register-1', cashierRef: session.email });
}

it('names one database per store and channel, apart from every catalogue database name, never holding the token', () => {
  expect(ordersDatabaseName(session)).not.toBe(databaseName(session));
  expect(ordersDatabaseName(session)).not.toMatch(/^vendurepos_[0-9a-f]{8}$/);
  expect(ordersDatabaseName(otherStore)).toMatch(/^vendurepos_orders_[0-9a-f]{8}$/);
  expect(ordersDatabaseName(otherStore)).not.toBe(ordersDatabaseName(session));
  expect(ordersDatabaseName({ ...otherStore })).toBe(ordersDatabaseName(otherStore));
});

it("opens the outbox only once the store's settings, and so its order.create version, are read", () => {
  // Opened earlier, a pending order's first send would go at order.create 3 and keep that version for good.
  expect(outboxStoreKey(session, { status: 'resolving', attempt: 1 })).toBeNull();
  expect(outboxStoreKey(session, { status: 'retrying', attempt: 2, lastError: new Error('offline') })).toBeNull();
  expect(outboxStoreKey(session, { status: 'plugin', attempt: 3 })).toBeNull();
  expect(outboxStoreKey(session, { status: 'ready', settings: session.settings, capabilities: { orderCreate: 4, register: 1 } }))
    .toBe(ordersDatabaseName(session));
});

it("keeps each store's orders apart, and a closed store's orders are there when it opens again", async () => {
  const order = cashSale();
  const here = await openOrderStore(ordersDatabaseName(session), PLATFORM);
  await here.orders.insert(order);
  const other = await openOrderStore(ordersDatabaseName(otherStore), PLATFORM);
  expect(await other.orders.findOne(order.id).exec()).toBeNull();
  await other.close();
  await here.close();
  expect(here.orders.closed).toBe(true);
  const again = await openOrderStore(ordersDatabaseName(session), PLATFORM);
  expect((await again.orders.findOne(order.id).exec())?.toJSON()).toMatchObject({ id: order.id, syncStatus: 'pending', totalMinor: 952 });
  await again.close();
});

it('opens a name again straight after a close() that is still running, and finds its orders', async () => {
  const name = ordersDatabaseName(session);
  const order = cashSale();
  const first = await openOrderStore(name, PLATFORM);
  await first.orders.insert(order);
  const settled: string[] = [];
  const closing = first.close().then(() => { settled.push('closed'); });
  const second = await openOrderStore(name, PLATFORM).finally(() => { settled.push('opened'); });
  await closing;
  // The reopen waited for the close (dev mode's ignoreDuplicate would let a production build's DB8 through here):
  // the first handle is closed, the second one open, and it holds the order.
  expect(settled).toEqual(['closed', 'opened']);
  expect(first.orders.closed).toBe(true);
  expect(second.orders.closed).toBe(false);
  expect((await second.orders.findOne(order.id).exec())?.id).toBe(order.id);
  await second.close();
});

it('still holds a stored order after sign-out removes the catalogue database, and after a reload', async () => {
  const name = ordersDatabaseName(session);
  await startCatalogueSync(session, catalogueConnector(session));
  const order = cashSale();
  const store = await openOrderStore(name, PLATFORM);
  await store.orders.insert(order);
  expect(await removeCatalogueDatabaseWithin()).toBe('removed');
  expect(store.orders.closed).toBe(false);
  expect((await store.orders.findOne(order.id).exec())?.id).toBe(order.id);
  // Signing in again reopens the catalogue under the same name; the order is still there.
  await startCatalogueSync(session, catalogueConnector(session));
  expect(await removeCatalogueDatabaseWithin()).toBe('removed');
  // The open handle keeps a removed memory store's documents, so read the order back as a reload would: the
  // database closed (memory storage keeps its data on close, never on remove), the module fresh, the store reopened.
  await store.close();
  vi.resetModules();
  const reloaded = await (await import('./orders-db')).openOrderStore(name, PLATFORM);
  expect((await reloaded.orders.findOne(order.id).exec())?.syncStatus).toBe('pending');
  await reloaded.close();
});

it("adds the register's collections to the orders database, and its records survive sign-out and a reload", async () => {
  const name = ordersDatabaseName(session);
  await startCatalogueSync(session, catalogueConnector(session));
  const store = await openOrderStore(name, PLATFORM);
  const register = registerCollections(store.orders)!;
  expect(register.sessions.database).toBe(store.orders.database);
  const minted = await readRegister(register.sessions);
  expect(minted).toMatchObject({ platform: PLATFORM });
  const opened = await openSession(register.sessions, {
    registerId: 'drawer-1', expectedFloatMinor: null, countedFloatMinor: 10000, openedBy: session.email,
    businessDay: { year: 2026, month: 9, day: 30 }, storeKey: name,
  });
  const movement = await recordMovement(register.sessions, register.movements, register.closures,
    { sessionId: opened.id, type: 'paid_in', amountMinor: 1000, reason: 'Change', actor: session.email });
  const commands = await reconcileRegisterCommands({ ...register, host: register.sessions, storeKey: name, registerId: 'drawer-1' });
  expect(commands).toEqual([`session.open:${opened.id}`, `movement.record:${movement.id}`]);
  // Sign-out removes the catalogue database only; the orders database is read back as a reload would, as above.
  expect(await removeCatalogueDatabaseWithin()).toBe('removed');
  await store.close();
  vi.resetModules();
  const reloadedModule = await import('./orders-db');
  const reloaded = await reloadedModule.openOrderStore(name, PLATFORM);
  const again = reloadedModule.registerCollections(reloaded.orders)!;
  expect((await again.sessions.findOne(opened.id).exec())?.status).toBe('open');
  expect((await again.movements.findOne(movement.id).exec())?.amountMinor).toBe(1000);
  expect((await again.commands.find().exec()).map(({ key }) => key)).toEqual(expect.arrayContaining(commands));
  // ensureRegister keeps the register document it minted.
  expect((await readRegister(again.sessions))?.id).toBe(minted!.id);
  await reloaded.close();
});
