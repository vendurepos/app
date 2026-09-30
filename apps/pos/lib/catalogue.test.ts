import type { SyncNotice } from '@tallyui/core';
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
    startIdReconcile: vi.fn(() => ({ reconcileIds: vi.fn(async () => ({})), stop: vi.fn() })),
    startFingerprintReconcile: vi.fn(() => ({ reconcile: vi.fn(async () => ({})), stop: vi.fn() })),
    startReplication: vi.fn(() => ({
      cancel: vi.fn(async () => {}), reSync: vi.fn(),
      active$: new Subject<boolean>(), error$: new Subject<Error>(), received$: new Subject(),
      notice$: new Subject<SyncNotice | undefined>(), resume: vi.fn(async () => {}),
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
        ...(start === startFingerprintReconcile ? { startDelayMs: 60_000 } : {}),
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

  it.each([0, 1, 2])('awaits runner %i after stopping before cancelling replication', async (pendingRunner) => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    const { replication } = await startCatalogueSync(session, catalogueConnector(session));
    const signal = vi.mocked(startReplication).mock.calls[0][0].context.signal;
    expect(signal?.aborted).toBe(false);
    const stops = [startStockReconcile, startIdReconcile, startFingerprintReconcile]
      .map((start) => vi.mocked(start).mock.results[0].value.stop);
    stops.forEach((stop) => vi.mocked(stop).mockImplementation(() => {
      expect(signal?.aborted).toBe(false);
    }));
    const runs = [
      vi.mocked(startStockReconcile).mock.results[0].value.reconcileStock,
      vi.mocked(startIdReconcile).mock.results[0].value.reconcileIds,
      vi.mocked(startFingerprintReconcile).mock.results[0].value.reconcile,
    ];
    let finish!: () => void;
    const pass = new Promise<void>((resolve) => { finish = resolve; });
    runs.forEach((run, index) => vi.mocked(run).mockClear().mockImplementationOnce(() => {
      stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
      expect(signal?.aborted).toBe(true);
      return index === pendingRunner ? pass : Promise.reject(new Error('Stopped'));
    }));
    vi.mocked(replication.cancel).mockImplementationOnce(async () => {
      expect(signal?.aborted).toBe(true);
      stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
    });
    let stopped = false;
    const stopping = stopCatalogueSync().then(() => { stopped = true; });
    await vi.waitFor(() => runs.forEach((run) => expect(run).toHaveBeenCalledTimes(1)));
    expect(stopped).toBe(false);
    expect(replication.cancel).not.toHaveBeenCalled();
    finish();
    await stopping;
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

  it.each([startStockReconcile, startIdReconcile, startFingerprintReconcile])('cancels replication when %s throws at start', async (start) => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    const error = new Error('Runner failed to start');
    vi.mocked(start).mockImplementationOnce(() => { throw error; });
    await expect(startCatalogueSync(session, catalogueConnector(session))).rejects.toBe(error);
    await stopCatalogueSync();
    const replication = vi.mocked(startReplication).mock.results[0].value;
    expect(replication.cancel).toHaveBeenCalledTimes(1);
    for (const runner of [startStockReconcile, startIdReconcile, startFingerprintReconcile]) {
      const result = vi.mocked(runner).mock.results[0];
      if (result?.type === 'return') expect(result.value.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('does not warn when the initial stock pass rejects after a stop', async () => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    let rejectPass!: (error: Error) => void;
    const reconcileStock = vi.fn<ReturnType<typeof startStockReconcile>['reconcileStock']>()
      .mockRejectedValue(new Error('Stopped'))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectPass = reject; }));
    vi.mocked(startStockReconcile).mockReturnValueOnce({
      reconcileStock, stop: vi.fn(() => rejectPass(new Error('Aborted'))), state$: new Subject(),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startCatalogueSync(session, catalogueConnector(session));
    await stopCatalogueSync();
    expect(warn).not.toHaveBeenCalled();
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

  it('shows a session the store refused from notice$ and keeps it over later sync events', async () => {
    const { useCatalogue: catalogueHook, SESSION_ENDED_TEXT } = await import('./use-catalogue');
    const { stopCatalogueSync } = await import('./catalogue');
    const setLastSyncedAt = vi.fn();
    const setError = vi.fn();
    vi.mocked(useMemo).mockImplementation((create) => create());
    vi.mocked(useState).mockReturnValueOnce([[], vi.fn()])
      .mockReturnValueOnce([null, setLastSyncedAt]).mockReturnValueOnce([null, setError])
      .mockReturnValueOnce([undefined, vi.fn()]).mockReturnValueOnce([undefined, vi.fn()]);
    let cleanup: (() => void) | void = undefined;
    vi.mocked(useEffect).mockImplementationOnce((effect) => { cleanup = effect(); });
    catalogueHook(session);
    await stopCatalogueSync();
    const replication = vi.mocked(startReplication).mock.results[0].value;
    // TallyUI 3.0 (#261): a refused session emits a till notice and ends the run with an empty page, never error$.
    const notice: SyncNotice = { code: 'unauthorized', since: Date.now(), fixedBy: 'till' };
    replication.active$.next(true);
    replication.notice$.next(notice);
    replication.active$.next(false);
    expect(setError).toHaveBeenLastCalledWith(SESSION_ENDED_TEXT);
    // A later reSync run returns the paused empty page: the catalogue must not report itself synced.
    replication.active$.next(true);
    replication.received$.next({});
    replication.error$.next(new Error('Later pull failed'));
    replication.active$.next(false);
    expect(setError).toHaveBeenLastCalledWith(SESSION_ENDED_TEXT);
    expect(setLastSyncedAt).not.toHaveBeenCalled();
    (cleanup as (() => void) | undefined)?.();
  });

  it('builds a new connector, and so new reconcile feeds, when the session moves to another store', async () => {
    const { useCatalogue: catalogueHook } = await import('./use-catalogue');
    const { stopCatalogueSync } = await import('./catalogue');
    // React's semantics: a memo or effect runs again only when one of its dependencies changes.
    const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));
    const memos: { deps: readonly unknown[]; value: unknown }[] = [];
    let slot = 0;
    vi.mocked(useMemo).mockImplementation((create, deps) => {
      const index = slot++;
      if (memos[index] && same(deps!, memos[index].deps)) return memos[index].value;
      memos[index] = { deps: deps!, value: create() };
      return memos[index].value;
    });
    vi.mocked(useState).mockImplementation((initial?: unknown) => [initial, vi.fn()] as any);
    let effectDeps: readonly unknown[] | undefined;
    let cleanup: (() => void) | void = undefined;
    vi.mocked(useEffect).mockImplementation((effect, deps) => {
      if (effectDeps && same(deps!, effectDeps)) return;
      (cleanup as (() => void) | undefined)?.();
      effectDeps = deps;
      cleanup = effect();
    });
    const render = (current: Session) => { slot = 0; return catalogueHook(current); };
    const first = render(session);
    expect(render(session).connector).toBe(first.connector);
    const other: Session = { ...session, url: 'https://another-store.example', token: 'other-token' };
    const second = render(other);
    await stopCatalogueSync();
    expect(second.connector).not.toBe(first.connector);
    // The connector's reconcile feed (TallyUI #307) is reached through the id and price enqueues and the product pull.
    // reconcile.stock is a stateless module constant in connector-vendure, shared by design.
    for (const feed of ['ids', 'prices'] as const) {
      expect(second.connector.reconcile![feed]!.enqueue).not.toBe(first.connector.reconcile![feed]!.enqueue);
    }
    expect(second.connector.replication!.products).not.toBe(first.connector.replication!.products);
    for (const start of [startReplication, startIdReconcile, startFingerprintReconcile]) {
      const [a, b] = vi.mocked(start).mock.calls.map(([options]) => options.adapter);
      expect(b).toBeDefined();
      expect(b).not.toBe(a);
    }
    (cleanup as (() => void) | undefined)?.();
  });

  it('returns reconciled stock for the chooser without mutating raw products', async () => {
    const { useCatalogue: catalogueHook } = await import('./use-catalogue');
    const raw = { id: 'product-1', variants: [{ id: 'variant-1', stockOnHand: 3 }] };
    const overlay = new Map([['variant-1', [{ stockLocationId: '1', stockOnHand: 9, stockAllocated: 0 }]]]);
    vi.mocked(useMemo).mockImplementation((create) => create());
    vi.mocked(useState).mockReturnValueOnce([[raw], vi.fn()])
      .mockReturnValueOnce([null, vi.fn()]).mockReturnValueOnce([null, vi.fn()])
      .mockReturnValueOnce([overlay, vi.fn()]).mockReturnValueOnce([undefined, vi.fn()]);
    const { products, connector, stockOverlay } = catalogueHook(session);
    expect(connector.traits.product.getVariants!(products[0])[0].stock?.quantity).toBe(7);
    expect(connector.traits.product.getVariants!(raw)[0].stock?.quantity).toBe(1);
    expect(products[0]).not.toBe(raw);
    expect(raw).toEqual({ id: 'product-1', variants: [{ id: 'variant-1', stockOnHand: 3 }] });
    expect(stockOverlay).toBe(overlay);
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
    const liveRows = vi.fn();
    const liveAsOf = vi.fn();
    const rowsSubscription = stockLevels.find().$.subscribe(liveRows);
    const asOfSubscription = stockLevels.getLocal$(STOCK_LEVELS_LAST_PASS).subscribe(liveAsOf);
    await stockLevels.upsert({ id: 'variant-1', value: { stockOnHand: 3 }, updatedAt: completedAt });
    await stockLevels.upsertLocal(STOCK_LEVELS_LAST_PASS, { completedAt: '2026-09-29T12:05:00.000Z' });
    await vi.waitFor(() => {
      expect(liveRows.mock.lastCall?.[0][0].toJSON().value).toEqual({ stockOnHand: 3 });
      expect(liveAsOf.mock.lastCall?.[0].get('completedAt')).toBe('2026-09-29T12:05:00.000Z');
    });
    expect(setOverlay).not.toHaveBeenCalled();
    expect(setAsOf).not.toHaveBeenCalled();
    rowsSubscription.unsubscribe();
    asOfSubscription.unsubscribe();
  });
});
