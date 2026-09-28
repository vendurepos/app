import { createTallyDatabase, getStorageHealth, startReplication } from '@tallyui/database';
import { useEffect, useMemo, useState } from 'react';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './session';

vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
vi.mock('react', async (importActual) => ({
  ...await importActual<typeof import('react')>(),
  useEffect: vi.fn(), useMemo: vi.fn((create) => create()), useState: vi.fn(),
}));
vi.mock('@tallyui/database', async (importActual) => {
  const actual = await importActual<typeof import('@tallyui/database')>();
  return {
    ...actual,
    createTallyDatabase: vi.fn(actual.createTallyDatabase),
    getStorageHealth: vi.fn(actual.getStorageHealth),
    startReplication: vi.fn(() => ({
      cancel: vi.fn(async () => {}), reSync: vi.fn(),
      active$: new Subject<boolean>(), error$: new Subject<Error>(), received$: new Subject(),
    })),
  };
});

const session: Session = {
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'test-token',
  settings: { currency: 'GBP', pricesIncludeTax: true, taxRatesPpm: { default: 200000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(async () => {
  const { removeCatalogueDatabase } = await import('./catalogue');
  await removeCatalogueDatabase();
  vi.restoreAllMocks();
});

describe('catalogue sync lifecycle', () => {
  it('names each store and channel deterministically with a valid RxDB name', async () => {
    const { databaseName } = await import('./catalogue');
    const name = databaseName(session);
    expect(databaseName({ ...session })).toBe(name);
    expect(name).toMatch(/^vendurepos_[0-9a-f]{8}$/);
    expect(name).toMatch(/^[a-z][a-z0-9_$-]*$/);
    expect(databaseName({ ...session, url: 'https://another-store.example' })).not.toBe(name);
    expect(databaseName({ ...session, channelToken: 'another-channel' })).not.toBe(name);
  });

  it('closes the previous store database and opens a different name', async () => {
    const { catalogueConnector, databaseName, startCatalogueSync } = await import('./catalogue');
    const first = await startCatalogueSync(session, catalogueConnector(session));
    const close = vi.spyOn(first.db, 'close');
    const other = { ...session, url: 'https://another-store.example' };
    const second = await startCatalogueSync(other, catalogueConnector(other));
    expect(createTallyDatabase).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createTallyDatabase).mock.calls.map(([options]) => options.name))
      .toEqual([databaseName(session), databaseName(other)]);
    expect(first.db.name).not.toBe(second.db.name);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels the replication when stopped after starting', async () => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    const { replication } = await startCatalogueSync(session, catalogueConnector(session));
    const signal = vi.mocked(startReplication).mock.calls[0][0].context.signal;
    expect(signal?.aborted).toBe(false);
    vi.mocked(replication.cancel).mockImplementationOnce(async () => {
      expect(signal?.aborted).toBe(true);
    });
    await stopCatalogueSync();
    expect(signal?.aborted).toBe(true);
    expect(replication.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a replication when stop is called before start resolves', async () => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    const a = startCatalogueSync(session, catalogueConnector(session));
    const b = stopCatalogueSync();
    const [{ replication }] = await Promise.all([a, b]);
    expect(replication.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the first replication when two starts overlap', async () => {
    const { catalogueConnector, startCatalogueSync } = await import('./catalogue');
    const connector = catalogueConnector(session);
    const a = startCatalogueSync(session, connector);
    const b = startCatalogueSync(session, connector);
    const [first, second] = await Promise.all([a, b]);
    expect(startReplication).toHaveBeenCalledTimes(2);
    expect(first.replication.cancel).toHaveBeenCalledTimes(1);
    expect(second.replication.cancel).not.toHaveBeenCalled();
  });

  it('cancels and removes the database so a later start creates it again', async () => {
    const { catalogueConnector, startCatalogueSync, removeCatalogueDatabase } = await import('./catalogue');
    const connector = catalogueConnector(session);
    const first = await startCatalogueSync(session, connector);
    await removeCatalogueDatabase();
    expect(first.replication.cancel).toHaveBeenCalledTimes(1);
    const second = await startCatalogueSync(session, connector);
    expect(createTallyDatabase).toHaveBeenCalledTimes(2);
    expect(second.db).not.toBe(first.db);
  });

  it('allows removal and a fresh start after opening the database rejects', async () => {
    const { catalogueConnector, startCatalogueSync, removeCatalogueDatabase } = await import('./catalogue');
    const connector = catalogueConnector(session);
    const error = new Error('Database failed to open');
    vi.mocked(createTallyDatabase).mockRejectedValueOnce(error);
    await expect(startCatalogueSync(session, connector)).rejects.toBe(error);
    expect(createTallyDatabase).toHaveBeenCalledTimes(1);
    await expect(removeCatalogueDatabase()).resolves.toBeUndefined();
    await expect(startCatalogueSync(session, connector)).resolves.toHaveProperty('db');
    expect(createTallyDatabase).toHaveBeenCalledTimes(2);
  });

  it('lets a following stop resolve after a start rejects', async () => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    const error = new Error('Replication failed');
    vi.mocked(startReplication).mockImplementationOnce(() => { throw error; });
    const a = startCatalogueSync(session, catalogueConnector(session));
    const b = stopCatalogueSync();
    await Promise.all([
      expect(a).rejects.toBe(error),
      expect(b).resolves.toBeUndefined(),
    ]);
  });

  it('times out a removal that never settles', async () => {
    const { catalogueConnector, startCatalogueSync, removeCatalogueDatabaseWithin } = await import('./catalogue');
    const { db } = await startCatalogueSync(session, catalogueConnector(session));
    const remove = vi.spyOn(db, 'remove').mockImplementationOnce(() => new Promise(() => {}));
    await expect(removeCatalogueDatabaseWithin(50)).resolves.toBe('timed_out');
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
    await db.remove();
    // The intentionally hung removal owns the old queue; discard it for cleanup.
    vi.resetModules();
  });

  it('reports removal failures without rejecting', async () => {
    const { catalogueConnector, startCatalogueSync, removeCatalogueDatabaseWithin } = await import('./catalogue');
    const { db } = await startCatalogueSync(session, catalogueConnector(session));
    const error = new Error('Removal failed');
    vi.spyOn(db, 'remove').mockRejectedValueOnce(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(removeCatalogueDatabaseWithin()).resolves.toBe('failed');
    expect(warn).toHaveBeenCalledWith('Failed to remove catalogue database', error);
    await db.remove();
  });

  it('reports successful removal', async () => {
    const { catalogueConnector, startCatalogueSync, removeCatalogueDatabaseWithin } = await import('./catalogue');
    await startCatalogueSync(session, catalogueConnector(session));
    await expect(removeCatalogueDatabaseWithin()).resolves.toBe('removed');
  });

  it('clears a pull error on receipt and keeps a dead storage error over later sync events', async () => {
    const { useCatalogue: catalogueHook } = await import('./use-catalogue');
    const { stopCatalogueSync } = await import('./catalogue');
    const setError = vi.fn();
    vi.mocked(useMemo).mockImplementation((create) => create());
    vi.mocked(useState).mockReturnValueOnce([[], vi.fn()])
      .mockReturnValueOnce([null, vi.fn()]).mockReturnValueOnce([null, setError]);
    let cleanup: (() => void) | void = undefined;
    vi.mocked(useEffect).mockImplementationOnce((effect) => { cleanup = effect(); });
    const health = new Subject<{ status: 'ok' | 'stalled' | 'dead'; stalledWrites: number }>();
    vi.mocked(getStorageHealth).mockReturnValueOnce(health);
    catalogueHook(session);
    // Joining the lifecycle queue waits for the hook's start and subscriptions.
    await stopCatalogueSync();
    const replication = vi.mocked(startReplication).mock.results[0].value;
    replication.active$.next(true);
    replication.error$.next(new Error('Pull failed'));
    expect(setError).toHaveBeenLastCalledWith('Pull failed');
    replication.active$.next(false);
    replication.active$.next(true);
    replication.received$.next({});
    expect(setError).toHaveBeenLastCalledWith(null);
    health.next({ status: 'dead', stalledWrites: 0 });
    replication.error$.next(new Error('Later pull failed'));
    replication.received$.next({});
    replication.active$.next(false);
    expect(setError).toHaveBeenLastCalledWith('Local storage stopped responding. Reload this page.');
    (cleanup as (() => void) | undefined)?.();
  });
});
