import { minorUnitDigits, moneyToMajor, resolvePrice, type ProductTraits, type StockStatus } from '@tallyui/core';
import { catalogueEntries, searchProducts, sortProducts, variantPriceLabel, type ProductSort, type ProductSortValue } from '@tallyui/pos';
import { stockTarget, type StockTarget, type VendureVariantStock } from './product-edit';

/** One variant's row in the Products panel (CHECKLIST 10.2), with display and edit fields. */
export interface ProductRow { id: string; productId: string; productName: string; name: string; sku: string; price: string; stock: string;
  imageUrl: string | null; stockStatus: StockStatus; categories: string; categoryIds: string[]; facetValueIds: string[];
  priceText: string; stockText: string; managed: boolean; stockTarget: StockTarget | null; optionSummary: OptionSummary }
/** v2's lines under a variable product's name (CHECKLIST 10.2m), e.g. "Size: S, M": each option group with the values its live variants carry. */
export type OptionSummary = { name: string; values: string[] }[];

/** Each option group in its own value order, kept to the values at least one live variant carries; a group left empty is dropped. */
function optionSummary<Doc>(product: Doc, traits: ProductTraits<Doc>): OptionSummary {
  const variants = traits.getVariants?.(product) ?? [];
  return (traits.getVariantOptions?.(product) ?? [])
    .map(group => ({ name: group.name, values: group.values.filter(value => variants.some(variant => variant.options?.[group.name] === value)) }))
    .filter(group => group.values.length > 0);
}
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
  // Once per product, from all its live variants (not only those the search or filters leave), as v2.
  const summaries = new Map<Doc, OptionSummary>();
  return (exact.length ? exact : entries).map(({ product, variant }) => {
    if (!summaries.has(product)) summaries.set(product, optionSummary(product, traits));
    const name = traits.getName(product);
    const option = variant.title?.startsWith(name) ? variant.title.slice(name.length).trim() : variant.title ?? '';
    const current = resolvePrice(variant.prices, currency)?.current;
    return {
      id: variant.id, productId: String(traits.getId(product)), productName: name, name: option ? `${name} · ${option}` : name,
      sku: variant.sku ?? '—', price: variantPriceLabel(variant, currency) ?? '—',
      stock: variant.stock.quantity == null ? '—' : String(variant.stock.quantity),
      imageUrl: traits.getImageUrl(product) ?? null, stockStatus: variant.stock.status,
      categories: traits.getCategoryNames(product).join(', ') || '—',
      categoryIds: (traits.getCategories?.(product) ?? []).map(c => c.id),
      facetValueIds: ((product as { facetValues?: { id: string }[] }).facetValues ?? []).map(value => value.id),
      priceText: current ? moneyToMajor(current).toFixed(minorUnitDigits(current.currency)) : '',
      stockText: variant.stock.quantity == null ? '' : String(variant.stock.quantity), managed: variant.stock.quantity != null,
      stockTarget: stockTarget((product as { variants?: ({ id: string | number } & VendureVariantStock)[] }).variants?.find(v => String(v.id) === variant.id), outOfStockThreshold),
      optionSummary: summaries.get(product)!,
    };
  });
}

/** A Products panel row: a variant, a product's "N variations" group row, or a variant drawn inside its open group (CHECKLIST 10.2j). */
export type PanelRow = ProductRow & { group?: { productId: string; count: number; open: boolean }; childOf?: string };
// A group's stock status is the first of these any of its rows has, else unknown.
const GROUP_STATUS_ORDER: StockStatus[] = ['in_stock', 'backorder', 'out_of_stock'];

/** v2's products table (08): a product with two or more rows left after search, filters and sort is one group row at its first row's place;
 * an open group's variants follow it in list order. The page limit and the counts are top-level rows (groups and plain rows), never an open group's children. */
export function groupProductRows(rows: ProductRow[], open: ReadonlySet<string>, limit: number): { shown: PanelRow[]; shownTop: number; totalTop: number } {
  const byProduct = new Map<string, ProductRow[]>();
  for (const row of rows) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row]);
  const top = [...byProduct.values()];
  const shown = top.slice(0, limit).flatMap((members): PanelRow[] => {
    const [first] = members;
    if (members.length < 2) return [first];
    const priced = members.filter(row => row.priceText !== '').sort((a, b) => Number(a.priceText) - Number(b.priceText));
    const [low, high] = [priced[0], priced.at(-1)];
    const isOpen = open.has(first.productId);
    const group: PanelRow = { ...first, id: `group-${first.productId}`, name: first.productName, sku: '—', stock: '—', stockText: '', managed: false, stockTarget: null,
      stockStatus: GROUP_STATUS_ORDER.find(status => members.some(row => row.stockStatus === status)) ?? 'unknown',
      price: !low || !high ? '—' : low.priceText === high.priceText ? low.price : `${low.price} – ${high.price}`,
      group: { productId: first.productId, count: members.length, open: isOpen } };
    return [group, ...(isOpen ? members.map(row => ({ ...row, childOf: first.productId })) : [])];
  });
  return { shown, shownTop: Math.min(limit, top.length), totalTop: top.length };
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
