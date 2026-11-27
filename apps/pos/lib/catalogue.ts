import { createVendureConnector } from '@tallyui/connector-vendure';
import { parseInfoCapabilities, type ServerCapabilities, type SyncContext, type TallyConnector } from '@tallyui/core';
import type { TallyDatabase, TallyReplicationState, STOCK_LEVELS_COLLECTION, getStorageHealth } from '@tallyui/database';
import { sessionContext, storeKeyHash, type Session } from './session';
import { appStorage } from './app-storage';
import { loadSyncCadence, onSyncCadenceChange } from './sync-cadence';

// One database per store, channel and barcode field so rows and checkpoints cannot be reused across settings.
export function databaseName({ url, channelToken, barcodeField }: Pick<Session, 'url' | 'channelToken' | 'barcodeField'>): string {
  const key = `${url}\n${channelToken ?? ''}${barcodeField ? `\n${barcodeField}` : ''}`;
  return `vendurepos_${storeKeyHash(key)}`;
}
// The default skips the start pass and restarts a 24 h wait on every start, so a till reloaded daily would never run one.
export const PRICE_RECONCILE_START_DELAY_MS = 60_000;
// A hung storage worker must not prevent the cashier from signing out.
const SIGN_OUT_WAIT_MS = 5_000;

let database: Promise<TallyDatabase> | undefined;
let sync: { replication: TallyReplicationState<any, any>; controller: AbortController; timer: ReturnType<typeof setInterval>; runners: { stop(): void; runNow(): Promise<unknown> }[]; unlisten: () => void; refresh: () => void } | undefined;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result;
  return result;
}

// The plugin's /info route, as connector-vendure reads it (CAPABILITIES_PATH).
const INFO_PATH = '/tally/v1/info';
const warnInfo = (reason: string) => console.warn(`@tallyui/connector-vendure: ${reason}`);

/** parseInfoCapabilities' answer, plus `cashRounding: true` when /info advertises it at a version (ADR-094, plugin ADR 0009). */
export function withCashRounding(body: unknown, parsed: ServerCapabilities | undefined): ServerCapabilities | undefined {
  const advertised = (body as { cashRounding?: unknown } | null | undefined)?.cashRounding;
  const v = typeof advertised === 'object' && advertised !== null ? (advertised as { v?: unknown }).v : undefined;
  return parsed && typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? { ...parsed, cashRounding: true } : parsed;
}

/** `parsed` plus `chargeTaxMode: true` when /info advertises it at a version (vendurepos 2.10b, app#523): the till then sends a charge's own tax mode. */
export function withChargeTaxMode(body: unknown, parsed: ServerCapabilities | undefined): ServerCapabilities | undefined {
  const advertised = (body as { chargeTaxMode?: unknown } | null | undefined)?.chargeTaxMode;
  const v = typeof advertised === 'object' && advertised !== null ? (advertised as { v?: unknown }).v : undefined;
  return parsed && typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? { ...parsed, chargeTaxMode: true } : parsed;
}

// One /info read per call, answered as readVendureCapabilities would: a second read could succeed where this one failed and drop cashRounding (#517).
// 404 is the connector's { orderCreate: 1 }. 401/403 call it only for its signed-out check (signedOut is not exported), which throws or answers
// undefined; any other answer came from a second read, so this read is inconclusive. A throw, non-ok status or non-JSON body is undefined.
async function readInfo(context: SyncContext, original: NonNullable<TallyConnector['capabilities']>): Promise<ServerCapabilities | undefined> {
  let response: Response;
  try {
    response = await fetch(`${context.baseUrl}${INFO_PATH}`, { method: 'GET', headers: context.headers, signal: context.signal });
  } catch {
    return undefined;
  }
  // readVendureCapabilities' own answer to a 404 (connector-vendure 5.3.0): an old plugin without /info takes order.create 1.
  if (response.status === 404) return { orderCreate: 1 };
  if (response.status === 401 || response.status === 403) {
    await original(context);
    return undefined;
  }
  if (!response.ok) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  return withChargeTaxMode(body, withCashRounding(body, parseInfoCapabilities(body, warnInfo)));
}

export function catalogueConnector(session: Session): TallyConnector {
  const connector = createVendureConnector({
    barcodeField: session.barcodeField,
    pricesIncludeTax: session.settings.pricesIncludeTax,
    globalTrackInventory: session.stock.trackInventory,
    globalOutOfStockThreshold: session.stock.outOfStockThreshold,
  });
  const original = connector.capabilities;
  if (!original) return connector;
  // This read replaces connector-vendure 5.3.0's, which drops /info's cashRounding, so the app maps cashRounding and chargeTaxMode itself; this goes when the connector maps both.
  // The connector is a plain object of closures (none reads `this`), so a spread keeps every other method as it is.
  return {
    ...connector,
    capabilities: (context) => readInfo(context, original),
  };
}

export async function startCatalogueSync(session: Session, connector: TallyConnector): Promise<{
  db: TallyDatabase; replication: TallyReplicationState<any, any>; stockLevels: TallyDatabase[typeof STOCK_LEVELS_COLLECTION];
  health: ReturnType<typeof getStorageHealth>;
}> {
  return enqueue(() => startUnqueued(session, connector));
}

// Reads that Sync now repeats with the catalogue (the collection images, CHECKLIST 1.5b).
const refreshListeners = new Set<() => void>();
export function onCatalogueRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => { refreshListeners.delete(listener); };
}

/** Sync now: re-pulls the catalogue and re-reads stock at once, as on focus or coming online; false while no sync runs. */
export function refreshCatalogue(): boolean {
  if (!sync) return false;
  sync.refresh();
  refreshListeners.forEach(listener => listener());
  return true;
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
  const cadence = loadSyncCadence();
  const replication = startReplication({
    collection: db.products,
    adapter: connector.replication!.products!,
    context,
    live: true,
    pullBatchSize: cadence.pullBatchSize,
  });
  const stockLevels = db[STOCK_LEVELS_COLLECTION];
  sync = { replication, controller, runners: [], timer: setInterval(() => replication.reSync(), cadence.checkIntervalMs), unlisten: () => {}, refresh: () => {} };
  const currentSync = sync;
  // RxDB fixes the page size at start; a changed page size applies only at the next start.
  const unlistenCadence = onSyncCadenceChange(next => {
    if (sync !== currentSync) return;
    clearInterval(sync.timer);
    sync.timer = setInterval(() => replication.reSync(), next.checkIntervalMs);
  });
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
  sync.refresh = refresh;
  const onVisibilityChange = () => { if (document.visibilityState === 'visible') refresh(); };
  const visibility = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : undefined;
  const network = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined;
  visibility?.addEventListener('visibilitychange', onVisibilityChange);
  network?.addEventListener('online', refresh);
  sync.unlisten = () => {
    unlistenCadence();
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
