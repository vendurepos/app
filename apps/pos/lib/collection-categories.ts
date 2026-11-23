import { useEffect, useMemo, useState } from 'react';
import type { ProductCategory, ProductTraits, SyncContext } from '@tallyui/core';
import { listCategories } from '@tallyui/pos';
import { onCatalogueRefresh } from './catalogue';
import { sessionContext, type Session } from './session';

// One page of the channel's collections; a store with more is read page by page, well under Vendure's list limit.
const COLLECTIONS_PAGE = 100;

/** A Vendure collection's featured image (CHECKLIST 1.5b): its preview URL, the same form the product images use. */
export interface CollectionImage { id: string; name: string; featuredAsset: { preview: string } | null }

/** The channel's collections with their featured asset. Any failure (offline, a refusal, a store error) throws. */
export async function listCollectionImages(context: SyncContext): Promise<CollectionImage[]> {
  const query = `query CollectionImages($options: CollectionListOptions) {
    collections(options: $options) { totalItems items { id name featuredAsset { preview } } }
  }`;
  const items: CollectionImage[] = [];
  for (;;) {
    const response = await fetch(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
      body: JSON.stringify({ query, variables: { options: { skip: items.length, take: COLLECTIONS_PAGE } } }),
    });
    if (!response.ok) throw new Error(`Vendure API error: ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    const page: { totalItems: number; items: CollectionImage[] } = body.data.collections;
    items.push(...page.items);
    if (!page.items.length || items.length >= page.totalItems) return items;
  }
}

/**
 * The categories Catalogue derives, in its order, each with its collection's image by id; one without an image keeps
 * none. Null collections (the read failed or has not landed) give undefined, so Catalogue keeps its own tiles.
 */
export function withCollectionImages(categories: readonly ProductCategory[], collections: readonly CollectionImage[] | null): ProductCategory[] | undefined {
  if (!collections) return undefined;
  const images = new Map(collections.flatMap(c => c.featuredAsset?.preview ? [[String(c.id), c.featuredAsset.preview] as const] : []));
  return categories.map(category => {
    const imageUrl = images.get(category.id);
    return imageUrl ? { ...category, imageUrl } : category;
  });
}

/**
 * Catalogue's `categories` with the collection images: read once per session and again on Sync now, kept in memory
 * only. A 401 or 403 is a failure here, as for the till's other side reads: the catalogue's own sync signs the till out.
 */
export function useCollectionCategories(session: Session, products: readonly unknown[], traits: ProductTraits<any>): ProductCategory[] | undefined {
  const [collections, setCollections] = useState<CollectionImage[] | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => onCatalogueRefresh(() => setGeneration(current => current + 1)), []);
  useEffect(() => { setCollections(null); }, [session]);
  useEffect(() => {
    let cancelled = false;
    listCollectionImages(sessionContext(session)).then(
      items => { if (!cancelled) setCollections(items); },
      // A failed re-read keeps the last images; only a session change (above) clears them.
      () => {});
    return () => { cancelled = true; };
  }, [session, generation]);
  return useMemo(() => withCollectionImages(listCategories(products, traits), collections), [products, traits, collections]);
}
