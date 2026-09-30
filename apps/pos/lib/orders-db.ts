import { addPosOrderCollection, OrderContentMismatchError, sameSale, type PosOrder } from '@tallyui/pos';
import { useEffect, useState } from 'react';
import { addRxPlugin, createRxDatabase, type RxCollection, type RxDatabase, type RxError } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import type { Subscription } from 'rxjs';
import { appStorage } from './app-storage';

/**
 * Finalized sales wait in `pos_orders` until they are sent (VA5). It lives in its own database, never the
 * catalogue's: sign-out removes the catalogue database (removeCatalogueDatabaseWithin), and a sale whose money
 * is taken must survive that. So it is opened once per app lifetime, not per session, and nothing removes it.
 */
export const ORDERS_DATABASE_NAME = 'vendurepos_orders';
// As createTallyDatabase: it adds RxDB's dev mode outside production, which then refuses a storage without a validator (DVM1).
const DEV_MODE = process.env.NODE_ENV !== 'production';

let database: Promise<RxDatabase> | undefined;
let orders: Promise<RxCollection<PosOrder>> | undefined;

export function openOrders(): Promise<RxCollection<PosOrder>> {
  if (!orders) {
    const storage = appStorage();
    // After the storage, which sets RxDB's premium flag before dev mode's init reads it (createTallyDatabase's order).
    if (DEV_MODE) addRxPlugin(RxDBDevModePlugin);
    const db = database ??= createRxDatabase({
      name: ORDERS_DATABASE_NAME, multiInstance: false, ignoreDuplicate: DEV_MODE,
      storage: DEV_MODE ? wrappedValidateAjvStorage({ storage }) : storage,
    });
    const current = orders = db.then((opened) => addPosOrderCollection(opened));
    // The next call retries a failed open: pos_orders on the same database (addPosOrderCollection closed it), or both.
    current.catch(() => {
      if (orders === current) orders = undefined;
      db.catch(() => { if (database === db) database = undefined; });
    });
  }
  return orders;
}

/**
 * useSale's onSaleCompleted. A retried complete() hands over the order it may already have stored: the same id
 * and money-bearing content counts as stored and is never overwritten (useOrderOutbox.record's rule).
 */
export async function recordOrder(posOrder: PosOrder): Promise<void> {
  const collection = await openOrders();
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
export async function isOrderStored(posOrder: PosOrder): Promise<boolean> {
  const collection = await openOrders();
  const [stored] = await collection.storageInstance.findDocumentsById([posOrder.id], false);
  return !!stored && !stored._deleted && sameSale(stored, posOrder);
}

/** How many stored orders are waiting to be sent; null until the order store opens. */
export function usePendingOrderCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let subscription: Subscription | undefined;
    openOrders().then((collection) => {
      if (!cancelled) subscription = collection.count({ selector: { syncStatus: 'pending' } }).$.subscribe(setCount);
    }, (error) => console.warn('Failed to open the order store', error));
    return () => { cancelled = true; subscription?.unsubscribe(); };
  }, []);
  return count;
}
