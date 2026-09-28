import { createVendureConnector } from '@tallyui/connector-vendure';
import type { TallyConnector } from '@tallyui/core';
import { createTallyDatabase, startReplication, type TallyDatabase } from '@tallyui/database';
import type { RxStorage } from 'rxdb';
import type { RxReplicationState } from 'rxdb/plugins/replication';
import { sessionContext, type Session } from './session';
import { createStorage } from './storage';

// One database per store, channel and barcode field so rows and checkpoints cannot be reused across settings.
export function databaseName({ url, channelToken, barcodeField }: Pick<Session, 'url' | 'channelToken' | 'barcodeField'>): string {
  const key = `${url}\n${channelToken ?? ''}${barcodeField ? `\n${barcodeField}` : ''}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return `vendurepos_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
// Vendure's feeds have no push stream, so re-pull on this interval.
export const RESYNC_INTERVAL_MS = 60_000;
// A hung storage worker must not prevent the cashier from signing out.
export const SIGN_OUT_WAIT_MS = 5_000;

let storage: RxStorage<any, any> | undefined;
let database: Promise<TallyDatabase> | undefined;
let sync: { replication: RxReplicationState<any, any>; controller: AbortController; timer: ReturnType<typeof setInterval> } | undefined;
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
  db: TallyDatabase; replication: RxReplicationState<any, any>;
}> {
  return enqueue(() => startUnqueued(session, connector));
}

async function startUnqueued(session: Session, connector: TallyConnector) {
  await stopUnqueued();
  storage ??= createStorage();
  const name = databaseName(session);
  if (database) {
    const db = await database;
    if (db.name !== name) {
      await db.close().catch(() => {});
      database = undefined;
    }
  }
  database ??= createTallyDatabase({ connector, name, storage });
  const current = database;
  const db = await current.catch((error) => {
    if (database === current) database = undefined;
    throw error;
  });
  const controller = new AbortController();
  const replication = startReplication({
    collection: db.products,
    adapter: connector.replication!.products!,
    context: { ...sessionContext(session), signal: controller.signal },
    live: true,
  });
  sync = { replication, controller, timer: setInterval(() => replication.reSync(), RESYNC_INTERVAL_MS) };
  return { db, replication };
}

export async function stopCatalogueSync(): Promise<void> {
  return enqueue(stopUnqueued);
}

async function stopUnqueued(): Promise<void> {
  if (!sync) return;
  const current = sync;
  clearInterval(current.timer);
  current.controller.abort();
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
