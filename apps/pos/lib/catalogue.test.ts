import { createTallyDatabase, getStorageHealth, startReplication, startStockReconcile, startIdReconcile, startFingerprintReconcile, STOCK_LEVELS_COLLECTION, STOCK_LEVELS_LAST_PASS } from '@tallyui/database';
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
    startStockReconcile: vi.fn(() => ({ reconcileStock: vi.fn(async () => ({})), stop: vi.fn() })),
    startIdReconcile: vi.fn(() => ({ stop: vi.fn() })),
    startFingerprintReconcile: vi.fn(() => ({ stop: vi.fn() })),
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

it('uses distinct database names for different barcode fields', async () => {
  const { databaseName } = await import('./catalogue');
  const barcode = databaseName({ ...session, barcodeField: 'barcode' });
  expect(barcode).not.toBe(databaseName(session));
  expect(barcode).not.toBe(databaseName({ ...session, barcodeField: 'ean_13' }));
});

it('keeps the original database name when no barcode field is set', async () => {
  const { databaseName } = await import('./catalogue');
  let hash = 0x811c9dc5;
  for (const char of 'https://shop.example.com\npos') hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  expect(databaseName({ url: 'https://shop.example.com', channelToken: 'pos' }))
    .toBe(`vendurepos_${(hash >>> 0).toString(16).padStart(8, '0')}`);
});

afterEach(async () => {
  const { removeCatalogueDatabase } = await import('./catalogue');
  await removeCatalogueDatabase();
  vi.restoreAllMocks();
});

describe('catalogue sync lifecycle', () => {
  it('starts each reconcile runner with the replication context and runs stock immediately', async () => {
    const { catalogueConnector, startCatalogueSync } = await import('./catalogue');
    const connector = catalogueConnector(session);
    const { db, replication, stockLevels } = await startCatalogueSync(session, connector);
    const { context } = vi.mocked(startReplication).mock.calls[0][0];
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(stockLevels).toBe(db[STOCK_LEVELS_COLLECTION]);
    for (const [start, collection, adapter] of [
      [startStockReconcile, stockLevels, connector.reconcile!.stock!],
      [startIdReconcile, db.products, connector.reconcile!.ids!],
      [startFingerprintReconcile, db.products, connector.reconcile!.prices!],
    ] as const) {
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({
        collection, adapter, context,
        ...(start === startStockReconcile ? {} : { reSync: expect.any(Function) }),
      });
      expect(vi.mocked(start).mock.calls[0][0].context.signal).toBe(context.signal);
    }
    expect(vi.mocked(startStockReconcile).mock.results[0].value.reconcileStock).toHaveBeenCalledTimes(1);
    vi.mocked(startIdReconcile).mock.calls[0][0].reSync();
    vi.mocked(startFingerprintReconcile).mock.calls[0][0].reSync();
    expect(replication.reSync).toHaveBeenCalledTimes(2);
  });

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
    const stops = [startStockReconcile, startIdReconcile, startFingerprintReconcile]
      .map((start) => vi.mocked(start).mock.results[0].value.stop);
    stops.forEach((stop) => vi.mocked(stop).mockImplementation(() => {
      expect(signal?.aborted).toBe(false);
    }));
    vi.mocked(replication.cancel).mockImplementationOnce(async () => {
      expect(signal?.aborted).toBe(true);
      stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
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
    for (const start of [startStockReconcile, startIdReconcile, startFingerprintReconcile]) {
      expect(start).toHaveBeenCalledTimes(2);
      const [previous, current] = vi.mocked(start).mock.results.map((result) => result.value);
      expect(previous.stop).toHaveBeenCalledTimes(1);
      expect(vi.mocked(previous.stop).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(first.replication.cancel).mock.invocationCallOrder[0]);
      expect(current.stop).not.toHaveBeenCalled();
    }
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
      .mockReturnValueOnce([null, vi.fn()]).mockReturnValueOnce([null, setError])
      .mockReturnValueOnce([undefined, vi.fn()]).mockReturnValueOnce([undefined, vi.fn()]);
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

  it('subscribes to reconciled stock and its last successful pass until cleanup', async () => {
    const { useCatalogue: catalogueHook } = await import('./use-catalogue');
    const { stopCatalogueSync } = await import('./catalogue');
    const setOverlay = vi.fn();
    const setAsOf = vi.fn();
    vi.mocked(useMemo).mockImplementation((create) => create());
    vi.mocked(useState).mockReturnValueOnce([[], vi.fn()])
      .mockReturnValueOnce([null, vi.fn()]).mockReturnValueOnce([null, vi.fn()])
      .mockReturnValueOnce([undefined, setOverlay]).mockReturnValueOnce([undefined, setAsOf]);
    let cleanup: (() => void) | void = undefined;
    vi.mocked(useEffect).mockImplementationOnce((effect) => { cleanup = effect(); });
    catalogueHook(session);
    await stopCatalogueSync();
    const stockLevels = vi.mocked(startStockReconcile).mock.lastCall![0].collection;
    await vi.waitFor(() => expect(setOverlay).toHaveBeenLastCalledWith(new Map()));
    const completedAt = '2026-09-29T12:00:00.000Z';
    await stockLevels.insert({ id: 'variant-1', value: { stockOnHand: 7 }, updatedAt: completedAt });
    await stockLevels.upsertLocal(STOCK_LEVELS_LAST_PASS, { completedAt });
    await vi.waitFor(() => {
      expect(setOverlay).toHaveBeenLastCalledWith(new Map([['variant-1', { stockOnHand: 7 }]]));
      expect(setAsOf).toHaveBeenLastCalledWith(completedAt);
    });
    (cleanup as (() => void) | undefined)?.();
    setOverlay.mockClear();
    setAsOf.mockClear();
    await stockLevels.upsert({ id: 'variant-1', value: { stockOnHand: 3 }, updatedAt: completedAt });
    await stockLevels.upsertLocal(STOCK_LEVELS_LAST_PASS, { completedAt: '2026-09-29T12:05:00.000Z' });
    expect(setOverlay).not.toHaveBeenCalled();
    expect(setAsOf).not.toHaveBeenCalled();
  });
});
