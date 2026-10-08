import { createVendureConnector } from '@tallyui/connector-vendure';
import type { TallyConnector } from '@tallyui/core';
import type { TallyDatabase, TallyReplicationState, STOCK_LEVELS_COLLECTION, getStorageHealth } from '@tallyui/database';
import { sessionContext, storeKeyHash, type Session } from './session';
import { appStorage } from './app-storage';

// One database per store, channel and barcode field so rows and checkpoints cannot be reused across settings.
export function databaseName({ url, channelToken, barcodeField }: Pick<Session, 'url' | 'channelToken' | 'barcodeField'>): string {
  const key = `${url}\n${channelToken ?? ''}${barcodeField ? `\n${barcodeField}` : ''}`;
  return `vendurepos_${storeKeyHash(key)}`;
}
// Vendure's feeds have no push stream, so re-pull on this interval.
export const RESYNC_INTERVAL_MS = 60_000;
// The default skips the start pass and restarts a 24 h wait on every start, so a till reloaded daily would never run one.
export const PRICE_RECONCILE_START_DELAY_MS = 60_000;
// A hung storage worker must not prevent the cashier from signing out.
export const SIGN_OUT_WAIT_MS = 5_000;

let database: Promise<TallyDatabase> | undefined;
let sync: { replication: TallyReplicationState<any, any>; controller: AbortController; timer: ReturnType<typeof setInterval>; runners: { stop(): void; runNow(): Promise<unknown> }[]; unlisten: () => void } | undefined;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result;
  return result;
}

export function catalogueConnector(session: Session): TallyConnector {
  return createVendureConnector({
    barcodeField: session.barcodeField,
    pricesIncludeTax: session.settings.pricesIncludeTax,
    globalTrackInventory: session.stock.trackInventory,
    globalOutOfStockThreshold: session.stock.outOfStockThreshold,
  });
}

export async function startCatalogueSync(session: Session, connector: TallyConnector): Promise<{
  db: TallyDatabase; replication: TallyReplicationState<any, any>; stockLevels: TallyDatabase[typeof STOCK_LEVELS_COLLECTION];
  health: ReturnType<typeof getStorageHealth>;
}> {
  return enqueue(() => startUnqueued(session, connector));
}

async function startUnqueued(session: Session, connector: TallyConnector) {
  await stopUnqueued();
  const { createTallyDatabase, startReplication, startStockReconcile, startIdReconcile, startFingerprintReconcile, STOCK_LEVELS_COLLECTION, getStorageHealth } = await import('@tallyui/database');
  const name = databaseName(session);
  if (database) {
    const db = await database;
    if (db.name !== name) {
      await db.close().catch(() => {});
      database = undefined;
    }
  }
  database ??= createTallyDatabase({ connector, name, storage: appStorage() });
  const current = database;
  const db = await current.catch((error) => {
    if (database === current) database = undefined;
    throw error;
  });
  const controller = new AbortController();
  const context = { ...sessionContext(session), signal: controller.signal };
  const replication = startReplication({
    collection: db.products,
    adapter: connector.replication!.products!,
    context,
    live: true,
  });
  const stockLevels = db[STOCK_LEVELS_COLLECTION];
  sync = { replication, controller, runners: [], timer: setInterval(() => replication.reSync(), RESYNC_INTERVAL_MS), unlisten: () => {} };
  const stock = startStockReconcile({ collection: stockLevels, adapter: connector.reconcile!.stock!, context });
  sync.runners.push({ stop: stock.stop, runNow: stock.reconcileStock });
  const ids = startIdReconcile({ collection: db.products, adapter: connector.reconcile!.ids!, context, reSync: () => replication.reSync() });
  sync.runners.push({ stop: ids.stop, runNow: ids.reconcileIds });
  const prices = startFingerprintReconcile({ collection: db.products, adapter: connector.reconcile!.prices!, context, reSync: () => replication.reSync(), startDelayMs: PRICE_RECONCILE_START_DELAY_MS });
  sync.runners.push({ stop: prices.stop, runNow: prices.reconcile });
  stock.reconcileStock().catch(error => { if (!controller.signal.aborted) console.warn('Stock reconcile failed:', error); });
  // TallyUI calls for a stock reconcile "on foreground or resume", shortcutting the 5-minute interval.
  const refresh = () => {
    replication.reSync();
    stock.reconcileStock().catch(error => { if (!controller.signal.aborted) console.warn('Stock reconcile failed:', error); });
  };
  const onVisibilityChange = () => { if (document.visibilityState === 'visible') refresh(); };
  const visibility = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : undefined;
  const network = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined;
  visibility?.addEventListener('visibilitychange', onVisibilityChange);
  network?.addEventListener('online', refresh);
  sync.unlisten = () => {
    visibility?.removeEventListener('visibilitychange', onVisibilityChange);
    network?.removeEventListener('online', refresh);
  };
  const health = getStorageHealth(db);
  return { db, replication, stockLevels, health };
}

export async function stopCatalogueSync(): Promise<void> {
  return enqueue(stopUnqueued);
}

async function stopUnqueued(): Promise<void> {
  if (!sync) return;
  const current = sync;
  current.unlisten();
  clearInterval(current.timer);
  current.runners.forEach(({ stop }) => stop());
  current.controller.abort();
  await Promise.allSettled(current.runners.map(({ runNow }) => runNow()));
  await current.replication.cancel();
  if (sync === current) sync = undefined;
}

export async function removeCatalogueDatabase(): Promise<void> {
  return enqueue(removeUnqueued);
}

export async function removeCatalogueDatabaseWithin(ms = SIGN_OUT_WAIT_MS): Promise<'removed' | 'timed_out' | 'failed'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      removeCatalogueDatabase().then(() => 'removed' as const, (error) => {
        console.warn('Failed to remove catalogue database', error);
        return 'failed' as const;
      }),
      new Promise<'timed_out'>((resolve) => { timer = setTimeout(() => resolve('timed_out'), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeUnqueued(): Promise<void> {
  await stopUnqueued();
  if (!database) return;
  const current = database;
  database = undefined;
  const db = await current.catch(() => undefined);
  if (db) await db.remove();
}
