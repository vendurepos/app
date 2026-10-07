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
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'refused-token',
  settings: { currency: 'GBP', pricesIncludeTax: true, taxRatesPpm: { default: 200000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};

afterEach(async () => {
  const { removeCatalogueDatabase } = await import('./catalogue');
  await removeCatalogueDatabase();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('asks to sign in again with the sign-in words when the store answers a product pull with 403', async () => {
  const { useCatalogue } = await import('./use-catalogue');
  const { POS_ACCESS_REFUSED_TEXT } = await import('./sign-in');
  const { stopCatalogueSync } = await import('./catalogue');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const setLastSyncedAt = vi.fn();
  const setError = vi.fn();
  vi.mocked(useState).mockReturnValueOnce([[], vi.fn()])
    .mockReturnValueOnce([null, setLastSyncedAt]).mockReturnValueOnce([null, setError])
    .mockReturnValueOnce([undefined, vi.fn()]).mockReturnValueOnce([undefined, vi.fn()]);
  vi.mocked(useMemo).mockImplementation((create) => create());
  let cleanup: (() => void) | void = undefined;
  vi.mocked(useEffect).mockImplementationOnce((effect) => { cleanup = effect(); });
  useCatalogue(session);
  await vi.waitFor(() => expect(setError).toHaveBeenCalledWith(POS_ACCESS_REFUSED_TEXT));
  expect(fetch.mock.calls.some(([url]) => String(url).startsWith(`${session.url}/`))).toBe(true);
  // Let the refused run end: it must not clear the error or report the catalogue synced.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(setError).toHaveBeenLastCalledWith(POS_ACCESS_REFUSED_TEXT);
  expect(setLastSyncedAt).not.toHaveBeenCalled();
  (cleanup as (() => void) | undefined)?.();
  await stopCatalogueSync();
});
