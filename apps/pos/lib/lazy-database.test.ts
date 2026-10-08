import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ database: false, devMode: false, validateAjv: false }));

vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
vi.mock('@tallyui/database', (importActual) => {
  loaded.database = true;
  return importActual();
});
vi.mock('rxdb/plugins/dev-mode', (importActual) => {
  loaded.devMode = true;
  return importActual();
});
vi.mock('rxdb/plugins/validate-ajv', (importActual) => {
  loaded.validateAjv = true;
  return importActual();
});

it('importing catalogue, use-catalogue and orders-db loads neither @tallyui/database nor RxDB dev mode', async () => {
  await import('./catalogue');
  await import('./use-catalogue');
  await import('./orders-db');
  expect(loaded).toEqual({ database: false, devMode: false, validateAjv: false });
});
