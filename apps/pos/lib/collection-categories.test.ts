import { describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { listCollectionImages, withCollectionImages } from './collection-categories';

const derived = [{ id: '3', name: 'Apparel' }, { id: '1', name: 'Coffee' }, { id: '2', name: 'Drinkware' }];

describe('collection categories', () => {
  it('adds each collection image by id, keeps a collection without one bare, ignores other ids and keeps the order', () => {
    expect(withCollectionImages(derived, [
      { id: '1', name: 'Coffee', featuredAsset: { preview: 'https://store.test/assets/coffee__preview.jpg' } },
      { id: '2', name: 'Drinkware', featuredAsset: null },
      { id: '9', name: 'Hidden', featuredAsset: { preview: 'https://store.test/assets/hidden__preview.jpg' } },
    ])).toEqual([
      { id: '3', name: 'Apparel' },
      { id: '1', name: 'Coffee', imageUrl: 'https://store.test/assets/coffee__preview.jpg' },
      { id: '2', name: 'Drinkware' },
    ]);
  });

  it('gives undefined while the read has not landed or failed, so Catalogue keeps its own tiles', () => {
    expect(withCollectionImages(derived, null)).toBeUndefined();
  });

  it('reads every page of the channel collections through the Admin API, and throws on a refusal', async () => {
    const reply = (items: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data: { collections: { totalItems: 101, items } } }) });
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), name: `C${i + 1}`, featuredAsset: null }))))
      .mockResolvedValueOnce(reply([{ id: '101', name: 'C101', featuredAsset: { preview: 'p' } }]))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    try {
      const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
      expect(await listCollectionImages(context)).toHaveLength(101);
      expect(fetch.mock.calls[0][0]).toBe('https://store.test/admin-api');
      expect(JSON.parse(fetch.mock.calls[1][1].body).variables.options).toEqual({ skip: 100, take: 100 });
      await expect(listCollectionImages(context)).rejects.toThrow('403');
    } finally { vi.unstubAllGlobals(); }
  });
});
