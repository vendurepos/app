import { describe, expect, it, vi } from 'vitest';
import type { ProductTraits, SyncContext } from '@tallyui/core';
import { listPublicFacets, productFacets, PUBLIC_FACET_OPTIONS, shownFacetIds, withFacetTerms } from './product-facets';

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

  it("gives the Catalogue each product's public facet values as terms, keyed by facet, less category and private facets", () => {
    // The store lists public facets only (Supplier, id 3, is private); category is hidden.
    const shown = shownFacetIds([{ id: '1', code: 'category' }, { id: '2', code: 'brand' }, { id: '4', code: 'colour' }]);
    const traits = withFacetTerms({ getId: (doc: { id: string }) => doc.id } as unknown as ProductTraits<any>, shown);
    const mug = { id: 'm', facetValues: [
      { id: '1', name: 'Drinkware', facet: { id: '1', name: 'category' } },
      { id: '6', name: 'Tally', facet: { id: '2', name: 'Brand' } },
      { id: '9', name: 'Blue', facet: { id: '4', name: 'Colour' } },
      { id: '8', name: 'Roastery Direct', facet: { id: '3', name: 'Supplier' } },
    ] };
    expect(traits.getTerms!(mug)).toEqual([
      { group: '2', groupName: 'Brand', id: '6', name: 'Tally' },
      { group: '4', groupName: 'Colour', id: '9', name: 'Blue' },
    ]);
    expect(traits.getTerms!({ id: 'bare' })).toEqual([]);
    expect(withFacetTerms(traits, null).getTerms!(mug)).toEqual([]);
    expect(traits.getId({ id: 'm' })).toBe('m');
  });
});
