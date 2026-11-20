import type { CatalogueProduct } from './catalogue';

/**
 * The demo store's facets (10.2i). `category` mirrors the collections, as the dev store's CSV import makes it; Brand
 * is public; Supplier is private (Vendure isPrivate), so the till never shows it (Front desk ruling, 2026-11-21).
 */
export const DEMO_FACETS = [
  { id: '1', name: 'category', code: 'category', isPrivate: false },
  { id: '2', name: 'Brand', code: 'brand', isPrivate: false },
  { id: '3', name: 'Supplier', code: 'supplier', isPrivate: true },
];
const CATEGORY_VALUE_IDS: Record<CatalogueProduct['category'], string> = { Coffee: '1', Drinkware: '2', Apparel: '3', Stationery: '4', Gifts: '5' };

/** The demo's brand: the Tally goods are Tally, the rest House. */
export function demoBrand(product: CatalogueProduct): 'Tally' | 'House' {
  return product.name.startsWith('Tally ') ? 'Tally' : 'House';
}

/** A product's facet values, in the synced shape: its category, its brand and, for coffee, its private supplier. */
export function demoFacetValues(product: CatalogueProduct) {
  const facet = (id: string) => { const { name } = DEMO_FACETS.find(f => f.id === id)!; return { id, name }; };
  const brand = demoBrand(product);
  return [
    { id: CATEGORY_VALUE_IDS[product.category], name: product.category, code: product.category.toLowerCase(), facet: facet('1') },
    { id: brand === 'Tally' ? '6' : '7', name: brand, code: brand.toLowerCase(), facet: facet('2') },
    ...(product.category === 'Coffee' ? [{ id: '8', name: 'Roastery Direct', code: 'roastery-direct', facet: facet('3') }] : []),
  ];
}
