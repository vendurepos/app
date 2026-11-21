import { minorUnitDigits, moneyToMajor, resolvePrice, type ProductTraits, type StockStatus } from '@tallyui/core';
import { catalogueEntries, searchProducts, sortProducts, variantPriceLabel, type ProductSort, type ProductSortValue } from '@tallyui/pos';
import { stockTarget, type StockTarget, type VendureVariantStock } from './product-edit';

/** One variant's row in the Products panel (CHECKLIST 10.2), with display and edit fields. */
export interface ProductRow { id: string; name: string; sku: string; price: string; stock: string;
  imageUrl: string | null; stockStatus: StockStatus; categories: string; categoryIds: string[]; facetValueIds: string[];
  priceText: string; stockText: string; managed: boolean; stockTarget: StockTarget | null }
/** The Products panel's header sort value for a row (v2's sortable headers): Name, SKU, Stock and Price; a missing value sorts last. */
export function productRowSortValue(row: ProductRow, field: string): ProductSortValue {
  if (field === 'name') return row.name;
  if (field === 'sku') return row.sku === '—' ? undefined : row.sku;
  if (field === 'stock') return row.stockText === '' ? undefined : Number(row.stockText);
  if (field === 'price') return row.priceText === '' ? undefined : Number(row.priceText);
  return undefined;
}
/** The whole filtered list in header-sort order, before the panel's page slice; null keeps catalogue order (the same array). */
export function sortProductRows(rows: ProductRow[], sort: ProductSort | null): ProductRow[] { return sortProducts(rows, sort, productRowSortValue); }

/** v2's stock-status labels (products table); unknown shows a dash. */
export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  in_stock: 'In stock', out_of_stock: 'Out of stock', backorder: 'On backorder', unknown: '—',
};

/** One row per variant in catalogue order, filtered by the till's own search; an exact SKU or barcode keeps that variant alone. */
export function productRows<Doc>(products: Doc[], term: string, traits: ProductTraits<Doc>, currency: string, outOfStockThreshold: number): ProductRow[] {
  const entries = catalogueEntries(searchProducts(products, term, traits), traits, { currency });
  const code = term.trim().toLowerCase();
  const exact = code ? entries.filter(({ variant }) => variant.sku?.toLowerCase() === code || variant.barcode?.toLowerCase() === code) : [];
  return (exact.length ? exact : entries).map(({ product, variant }) => {
    const name = traits.getName(product);
    const option = variant.title?.startsWith(name) ? variant.title.slice(name.length).trim() : variant.title ?? '';
    const current = resolvePrice(variant.prices, currency)?.current;
    return {
      id: variant.id, name: option ? `${name} · ${option}` : name,
      sku: variant.sku ?? '—', price: variantPriceLabel(variant, currency) ?? '—',
      stock: variant.stock.quantity == null ? '—' : String(variant.stock.quantity),
      imageUrl: traits.getImageUrl(product) ?? null, stockStatus: variant.stock.status,
      categories: traits.getCategoryNames(product).join(', ') || '—',
      categoryIds: (traits.getCategories?.(product) ?? []).map(c => c.id),
      facetValueIds: ((product as { facetValues?: { id: string }[] }).facetValues ?? []).map(value => value.id),
      priceText: current ? moneyToMajor(current).toFixed(minorUnitDigits(current.currency)) : '',
      stockText: variant.stock.quantity == null ? '' : String(variant.stock.quantity), managed: variant.stock.quantity != null,
      stockTarget: stockTarget((product as { variants?: ({ id: string | number } & VendureVariantStock)[] }).variants?.find(v => String(v.id) === variant.id), outOfStockThreshold),
    };
  });
}

/** The panel's own filters (v2's In Stock, Category, Tags and Brands pills); null category means all; facets maps a facet id to its chosen value id. */
export interface ProductRowFilters { inStock: boolean; categoryId: string | null; facets?: Record<string, string> }

/** In Stock drops only out-of-stock rows (untracked and backorder variants stay sellable); a category keeps that category's rows; each chosen facet value keeps that value's rows. */
export function filterProductRows(rows: ProductRow[], filters: ProductRowFilters): ProductRow[] {
  return rows.filter(row => (!filters.inStock || row.stockStatus !== 'out_of_stock') &&
    (!filters.categoryId || row.categoryIds.includes(filters.categoryId)) &&
    Object.values(filters.facets ?? {}).every(id => row.facetValueIds.includes(id)));
}

/** The categories of the listed products, each once, by name (the Category pill's choices). */
export function productCategories<Doc>(products: Doc[], traits: ProductTraits<Doc>): { id: string; name: string }[] {
  const categories = new Map((products.flatMap(product => traits.getCategories?.(product) ?? [])).map(c => [c.id, c]));
  return [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
}
