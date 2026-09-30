import { addPosOrderCollection, OrderContentMismatchError, sameSale, type PosOrder } from '@tallyui/pos';
import { useEffect, useState } from 'react';
import { addRxPlugin, createRxDatabase, type RxCollection, type RxDatabase, type RxError } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import type { Subscription } from 'rxjs';
import { appStorage } from './app-storage';
import { storeKeyHash, type Session } from './session';

/** The store and channel a sale was taken for: its orders are that store's money, and only that store's. */
export type OrderStore = Pick<Session, 'url' | 'channelToken'>;

/**
 * Finalized sales wait in `pos_orders` until they are sent (VA5). Each store and channel has its own database,
 * never the catalogue's: sign-out removes the catalogue database (removeCatalogueDatabaseWithin), and a sale whose
 * money is taken must survive that; a till signed in to store B must never count or send store A's orders. So
 * nothing removes an orders database, and it is named by a hash, never the channel token itself.
 */
export function ordersDatabaseName({ url, channelToken }: OrderStore): string {
  return `vendurepos_orders_${storeKeyHash(`${url}\n${channelToken ?? ''}`)}`;
}
// As createTallyDatabase: it adds RxDB's dev mode outside production, which then refuses a storage without a validator (DVM1).
const DEV_MODE = process.env.NODE_ENV !== 'production';

// The signed-in store's database; a store switch closes it first, so a name is never open twice.
let current: { name: string; database?: Promise<RxDatabase>; orders?: Promise<RxCollection<PosOrder>> } | undefined;
let closing: Promise<unknown> = Promise.resolve();

export function openOrders(store: OrderStore): Promise<RxCollection<PosOrder>> {
  const name = ordersDatabaseName(store);
  if (current?.name !== name) {
    // Closed, never removed: the last store's orders wait for its next sign-in.
    const previous = current?.database;
    if (previous) closing = closing.then(() => previous).then((db) => db.close()).catch(() => undefined);
    current = { name };
  }
  const slot = current;
  if (!slot.orders) {
    const storage = appStorage();
    // After the storage, which sets RxDB's premium flag before dev mode's init reads it (createTallyDatabase's order).
    if (DEV_MODE) addRxPlugin(RxDBDevModePlugin);
    const db = slot.database ??= closing.then(() => createRxDatabase({
      name, multiInstance: false, ignoreDuplicate: DEV_MODE,
      storage: DEV_MODE ? wrappedValidateAjvStorage({ storage }) : storage,
    }));
    const opened = slot.orders = db.then((database) => addPosOrderCollection(database));
    // The next call retries a failed open: pos_orders on the same database (addPosOrderCollection closed it), or both.
    opened.catch(() => {
      if (slot.orders === opened) slot.orders = undefined;
      db.catch(() => { if (slot.database === db) slot.database = undefined; });
    });
  }
  return slot.orders;
}

/**
 * useSale's onSaleCompleted. A retried complete() hands over the order it may already have stored: the same id
 * and money-bearing content counts as stored and is never overwritten (useOrderOutbox.record's rule).
 */
export async function recordOrder(store: OrderStore, posOrder: PosOrder): Promise<void> {
  const collection = await openOrders(store);
  try {
    await collection.insert(posOrder);
  } catch (error) {
    const stored = (error as RxError)?.code === 'CONFLICT' ? (error as RxError).parameters.writeError : undefined;
    const inDb = stored?.status === 409 ? stored.documentInDb : undefined;
    if (!inDb || inDb._deleted) throw error;
    if (!sameSale(inDb, posOrder)) throw new OrderContentMismatchError(posOrder.id);
  }
}

/** useSale's isStored: a primary-key read on the storage instance, past RxDB's query cache (useOrderOutbox.isStored's rule). */
export async function isOrderStored(store: OrderStore, posOrder: PosOrder): Promise<boolean> {
  const collection = await openOrders(store);
  const [stored] = await collection.storageInstance.findDocumentsById([posOrder.id], false);
  return !!stored && !stored._deleted && sameSale(stored, posOrder);
}

/** Calls onCount with the store's count of orders waiting to be sent, and again on each change; returns the unsubscribe. */
export function watchPendingOrders(store: OrderStore, onCount: (count: number) => void): () => void {
  let cancelled = false;
  let subscription: Subscription | undefined;
  openOrders(store).then((collection) => {
    if (!cancelled) subscription = collection.count({ selector: { syncStatus: 'pending' } }).$.subscribe(onCount);
  }, (error) => console.warn('Failed to open the order store', error));
  return () => { cancelled = true; subscription?.unsubscribe(); };
}

/** How many of the store's orders are waiting to be sent; null until its order store opens. */
export function usePendingOrderCount({ url, channelToken }: OrderStore): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => watchPendingOrders({ url, channelToken }, setCount), [url, channelToken]);
  return count;
}
