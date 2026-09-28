import { createTallyDatabase, startReplication } from '@tallyui/database';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './session';

vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
vi.mock('@tallyui/database', async (importActual) => {
  const actual = await importActual<typeof import('@tallyui/database')>();
  return {
    ...actual,
    createTallyDatabase: vi.fn(actual.createTallyDatabase),
    startReplication: vi.fn(() => ({ cancel: vi.fn(async () => {}), reSync: vi.fn() })),
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
});

describe('catalogue sync lifecycle', () => {
  it('cancels the replication when stopped after starting', async () => {
    const { catalogueConnector, startCatalogueSync, stopCatalogueSync } = await import('./catalogue');
    const { replication } = await startCatalogueSync(session, catalogueConnector(session));
    await stopCatalogueSync();
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
});
