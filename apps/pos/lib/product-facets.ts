import { useEffect, useMemo, useState } from 'react';
import type { ProductTraits, SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';

// The collection-mirroring facet: Vendure's CSV import (and the dev store) put each product's collection in a `category`
// facet; the Category pill already lists collections, so a second pill would repeat it (Front desk ruling, 2026-11-21).
export const HIDDEN_FACET_CODES = ['category'];
// Only public facets are read (Vendure isPrivate; Front desk ruling, 2026-11-21). 100 is far above any till's facet count.
export const PUBLIC_FACET_OPTIONS = { take: 100, filter: { isPrivate: { eq: false } } };

/** One product facet with the values the listed products carry, each sorted by name (a facet pill and its picker). */
export interface ProductFacet { id: string; name: string; values: { id: string; name: string }[] }
type FacetValueDoc = { id: string; name: string; facet: { id: string; name: string } };

/** The store's public facets (id and code), as the till's role may read them. */
export async function listPublicFacets(context: SyncContext): Promise<{ id: string; code: string }[]> {
  const query = `query PublicFacets($options: FacetListOptions) { facets(options: $options) { items { id code } } }`;
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query, variables: { options: PUBLIC_FACET_OPTIONS } }),
  });
  if (response.status === 401 || response.status === 403) throw new Error(`Vendure API error: ${response.status}`);
  if (!response.ok) throw new Error(`Vendure API error: ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data.facets.items;
}

/** The facet ids that get a pill: the public ones, less the hidden codes. */
export function shownFacetIds(items: { id: string; code: string }[]): ReadonlySet<string> {
  return new Set(items.filter(item => !HIDDEN_FACET_CODES.includes(item.code)).map(item => item.id));
}

/** The product's values in the shown facets; none while `shown` is null. */
function shownFacetValues(product: unknown, shown: ReadonlySet<string> | null): FacetValueDoc[] {
  if (!shown) return [];
  return ((product as { facetValues?: FacetValueDoc[] }).facetValues ?? []).filter(value => shown.has(value.facet.id));
}

/** The traits with `getTerms`: the product's shown facet values, each in its facet (the sell screen's pills, 1.6c). */
export function withFacetTerms<Doc>(traits: ProductTraits<Doc>, shown: ReadonlySet<string> | null): ProductTraits<Doc> {
  return { ...traits, getTerms: doc => shownFacetValues(doc, shown)
    .map(value => ({ group: value.facet.id, groupName: value.facet.name, id: value.id, name: value.name })) };
}

/**
 * The shown facets of the listed products, each once, sorted by name. Null (privacy not known yet, or the read failed)
 * shows none, so a private facet never shows.
 */
export function productFacets(products: readonly unknown[], shown: ReadonlySet<string> | null): ProductFacet[] {
  const facets = new Map<string, ProductFacet>();
  for (const product of products) {
    for (const value of shownFacetValues(product, shown)) {
      const facet = facets.get(value.facet.id) ?? { id: value.facet.id, name: value.facet.name, values: [] };
      if (!facet.values.some(v => v.id === value.id)) facet.values.push({ id: value.id, name: value.name });
      facets.set(facet.id, facet);
    }
  }
  return [...facets.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map(facet => ({ ...facet, values: [...facet.values].sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** `shownFacetIds` for the signed-in session; null until the store answers, and null when it refuses or fails. */
export function usePublicFacetIds(session: Session): ReadonlySet<string> | null {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    setIds(null);
    let cancelled = false;
    listPublicFacets(sessionContext(session)).then(items => { if (!cancelled) setIds(shownFacetIds(items)); }, () => {});
    return () => { cancelled = true; };
  }, [session]);
  return ids;
}

/**
 * The Catalogue's facet pills (1.6c): its traits with `getTerms`, and one pill per shown facet the products carry, in
 * the Products panel's order. The picks stay in the Catalogue, which never persists them (10.2i: session only).
 */
export function useFacetTermPills<Doc>(session: Session, traits: ProductTraits<Doc>, products: readonly Doc[]): { traits: ProductTraits<Doc>; termPills: string[] } {
  const shown = usePublicFacetIds(session);
  const wrapped = useMemo(() => withFacetTerms(traits, shown), [traits, shown]);
  const termPills = useMemo(() => productFacets(products, shown).map(facet => facet.id), [products, shown]);
  return { traits: wrapped, termPills };
}
