import { createVendureConnector } from '@tallyui/connector-vendure';
import type { TallyConnector } from '@tallyui/core';
import { createTallyDatabase, startReplication, type TallyDatabase } from '@tallyui/database';
import type { RxStorage } from 'rxdb';
import type { RxReplicationState } from 'rxdb/plugins/replication';
import { sessionContext, type Session } from './session';
import { createStorage } from './storage';

// The one local database, removed on sign-out before another store can use it.
export const DATABASE_NAME = 'vendurepos';
// Vendure's feeds have no push stream, so re-pull on this interval.
export const RESYNC_INTERVAL_MS = 60_000;

let storage: RxStorage<any, any> | undefined;
let database: Promise<TallyDatabase> | undefined;
let sync: { replication: RxReplicationState<any, any>; timer: ReturnType<typeof setInterval> } | undefined;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result;
  return result;
}

export function catalogueConnector(session: Session): TallyConnector {
  return createVendureConnector({
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
  database ??= createTallyDatabase({ connector, name: DATABASE_NAME, storage });
  const current = database;
  const db = await current.catch((error) => {
    if (database === current) database = undefined;
    throw error;
  });
  const replication = startReplication({
    collection: db.products,
    adapter: connector.replication!.products!,
    context: sessionContext(session),
    live: true,
  });
  sync = { replication, timer: setInterval(() => replication.reSync(), RESYNC_INTERVAL_MS) };
  return { db, replication };
}

export async function stopCatalogueSync(): Promise<void> {
  return enqueue(stopUnqueued);
}

async function stopUnqueued(): Promise<void> {
  if (!sync) return;
  const current = sync;
  clearInterval(current.timer);
  await current.replication.cancel();
  if (sync === current) sync = undefined;
}

export async function removeCatalogueDatabase(): Promise<void> {
  return enqueue(removeUnqueued);
}

async function removeUnqueued(): Promise<void> {
  await stopUnqueued();
  if (!database) return;
  const current = database;
  database = undefined;
  const db = await current.catch(() => undefined);
  if (db) await db.remove();
}
