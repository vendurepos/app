import { useEffect, useMemo, useState } from 'react';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from './session';

// The real connector and replication (no @tallyui/database mock): only the network and React are stubbed.
vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
vi.mock('react', async (importActual) => ({
  ...await importActual<typeof import('react')>(),
  useEffect: vi.fn(), useMemo: vi.fn((create) => create()), useState: vi.fn(),
}));

const session: Session = {
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'expired-token',
  settings: { currency: 'GBP', pricesIncludeTax: true, taxRatesPpm: { default: 200000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};

afterEach(async () => {
  const { removeCatalogueDatabase } = await import('./catalogue');
  await removeCatalogueDatabase();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shows the session-ended notice when the store answers a product pull with 401', async () => {
  const { useCatalogue, SESSION_ENDED_TEXT } = await import('./use-catalogue');
  const { stopCatalogueSync } = await import('./catalogue');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const setLastSyncedAt = vi.fn();
  const setError = vi.fn();
  const setPullNotice = vi.fn();
  vi.mocked(useState).mockReturnValueOnce([[], vi.fn()])
    .mockReturnValueOnce([null, setLastSyncedAt]).mockReturnValueOnce([null, setError])
    .mockReturnValueOnce([undefined, vi.fn()]).mockReturnValueOnce([undefined, vi.fn()])
    .mockReturnValueOnce([undefined, setPullNotice]);
  vi.mocked(useMemo).mockImplementation((create) => create());
  let cleanup: (() => void) | void = undefined;
  vi.mocked(useEffect).mockImplementationOnce((effect) => { cleanup = effect(); });
  useCatalogue(session);
  await vi.waitFor(() => expect(setError).toHaveBeenCalledWith(SESSION_ENDED_TEXT));
  expect(fetch.mock.calls.some(([url]) => String(url).startsWith(`${session.url}/`))).toBe(true);
  expect(setPullNotice).toHaveBeenCalledWith(expect.objectContaining({ code: 'unauthorized', fixedBy: 'till' }));
  // Let the paused run end: it must not clear the notice or report the catalogue synced.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(setError).toHaveBeenLastCalledWith(SESSION_ENDED_TEXT);
  expect(setLastSyncedAt).not.toHaveBeenCalled();
  (cleanup as (() => void) | undefined)?.();
  await stopCatalogueSync();
});
