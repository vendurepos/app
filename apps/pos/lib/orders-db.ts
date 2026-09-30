import {
  addPosOrderCollection, cashMovementSchema, closureSchema, ensureRegister, registerCommandCollection, registerSessionCollection,
  type CashMovementCollection, type ClosureCollection, type PosOrder, type RegisterCommandCollection, type RegisterSessionCollection,
} from '@tallyui/pos';
import { addRxPlugin, createRxDatabase, type RxCollection } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { appStorage } from './app-storage';
import { storeKeyHash, type Session } from './session';
import type { SaleSettingsState } from './use-sale-settings';

/** The store and channel a sale was taken for: its orders are that store's money, and only that store's. */
export type OrderStore = Pick<Session, 'url' | 'channelToken'>;

/**
 * Finalized sales wait in `pos_orders` until useOrderOutbox sends them. Each store and channel has its own database,
 * never the catalogue's: sign-out removes the catalogue database (removeCatalogueDatabaseWithin), and a sale whose
 * money is taken must survive that; a till signed in to store B must never count or send store A's orders. So
 * nothing removes an orders database, and it is named by a hash, never the channel token itself.
 */
export function ordersDatabaseName({ url, channelToken }: OrderStore): string {
  return `vendurepos_orders_${storeKeyHash(`${url}\n${channelToken ?? ''}`)}`;
}

/**
 * useOrderOutbox's storeKey: none until the store's capabilities are read and at MIN_ORDER_CREATE. A first send takes
 * the store's order.create max, and without one it goes at 3, where the plugin's 4 carries the net-discount rule.
 */
export function outboxStoreKey(store: OrderStore, saleSettings: SaleSettingsState): string | null {
  return saleSettings.status === 'ready' ? ordersDatabaseName(store) : null;
}

// As createTallyDatabase: it adds RxDB's dev mode outside production, which then refuses a storage without a validator (DVM1).
const DEV_MODE = process.env.NODE_ENV !== 'production';

// Per name, settles once the last handle opened under it is closed (or its open failed): the next open waits for
// it, so a name is never open twice.
const released = new Map<string, Promise<void>>();

/** The register's collections, local fiscal records in the orders database beside pos_orders (TallyUI's INTEGRATION.md). */
export type RegisterCollections = {
  /** Also the register host: it holds the register document (the closure number and perpetual totals). */
  sessions: RegisterSessionCollection; movements: CashMovementCollection; closures: ClosureCollection; commands: RegisterCommandCollection;
};

/** The register collections openOrderStore added to `orders`' database; null while the orders are not open. */
export function registerCollections(orders: RxCollection<PosOrder> | null): RegisterCollections | null {
  if (!orders) return null;
  const { register_sessions, cash_movements, closures, register_commands } = orders.database.collections;
  return { sessions: register_sessions, movements: cash_movements, closures, commands: register_commands };
}

/**
 * useOrderOutbox's open. close() closes the database and never removes it: unsent orders, and the register's sessions,
 * movements and closures, wait for the next sign-in. `platform` is ensureRegister's, stamped on the register document.
 */
export async function openOrderStore(name: string, platform: string): Promise<{ orders: RxCollection<PosOrder>; close(): Promise<void> }> {
  const previous = released.get(name);
  let release!: () => void;
  released.set(name, new Promise<void>((resolve) => { release = resolve; }));
  try {
    await previous;
    const storage = appStorage();
    // After the storage, which sets RxDB's premium flag before dev mode's init reads it (createTallyDatabase's order).
    if (DEV_MODE) addRxPlugin(RxDBDevModePlugin);
    const database = await createRxDatabase({
      name, multiInstance: false, ignoreDuplicate: DEV_MODE,
      storage: DEV_MODE ? wrappedValidateAjvStorage({ storage }) : storage,
    });
    // A failed open closes the database here, so the next open, which retries it, starts afresh. pos_orders first, so
    // its migrations settle before anything reads it; then the register's, in INTEGRATION.md's order.
    const orders = await (async () => {
      const added = await addPosOrderCollection(database);
      const { register_sessions } = await database.addCollections({
        register_sessions: registerSessionCollection(), cash_movements: { schema: cashMovementSchema },
        closures: { schema: closureSchema }, register_commands: registerCommandCollection(),
      });
      await ensureRegister(register_sessions, platform);
      return added;
    })().catch(async (error: unknown) => {
      await database.close().catch(() => undefined);
      throw error;
    });
    let closing: Promise<void> | undefined;
    return { orders, close: () => closing ??= database.close().then(() => undefined).finally(release) };
  } catch (error) {
    release();
    throw error;
  }
}
