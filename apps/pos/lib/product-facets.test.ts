import { describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { listPublicFacets, productFacets, PUBLIC_FACET_OPTIONS, shownFacetIds } from './product-facets';

describe('product facets', () => {
  it('shows only the public facets the store returns, less the collection-mirroring category facet', () => {
    expect(shownFacetIds([{ id: '1', code: 'category' }, { id: '2', code: 'brand' }])).toEqual(new Set(['2']));
    expect(PUBLIC_FACET_OPTIONS).toEqual({ take: 100, filter: { isPrivate: { eq: false } } });
  });

  it('lists each shown facet once with its values sorted by name, and none before privacy is known', () => {
    const products = [
      { name: 'A', facetValues: [
        { id: '7', name: 'House', facet: { id: '2', name: 'Brand' } },
        { id: '8', name: 'Roastery Direct', facet: { id: '3', name: 'Supplier' } },
      ] },
      { name: 'B', facetValues: [{ id: '6', name: 'Tally', facet: { id: '2', name: 'Brand' } }] },
      { name: 'C' },
    ];
    expect(productFacets(products, new Set(['2']))).toEqual([
      { id: '2', name: 'Brand', values: [{ id: '7', name: 'House' }, { id: '6', name: 'Tally' }] },
    ]);
    expect(productFacets(products, null)).toEqual([]);
  });

  it('reads the public facets through the Admin API with the isPrivate filter', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ data: { facets: { items: [{ id: '2', code: 'brand' }] } } }),
    });
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await listPublicFacets({ baseUrl: 'https://store.test', headers: {} } as SyncContext)).toEqual([{ id: '2', code: 'brand' }]);
      expect(fetch.mock.calls[0][0]).toBe('https://store.test/admin-api');
      expect(JSON.parse(fetch.mock.calls[0][1].body).variables.options).toEqual(PUBLIC_FACET_OPTIONS);
    } finally { vi.unstubAllGlobals(); }
  });
});
