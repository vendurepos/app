import { minorUnitDigits, moneyToMajor, resolvePrice, type ProductTraits } from '@tallyui/core';
import { catalogueEntries, searchProducts, variantPriceLabel } from '@tallyui/pos';
import { stockTarget, type StockTarget, type VendureVariantStock } from './product-edit';

/** One variant's row in the Products panel (CHECKLIST 10.2), with display and edit fields. */
export interface ProductRow { id: string; name: string; sku: string; price: string; stock: string;
  priceText: string; stockText: string; managed: boolean; editable: boolean; stockTarget: StockTarget | null }

/** One row per variant in catalogue order, filtered by the till's own search; an exact SKU or barcode keeps that variant alone. */
export function productRows<Doc>(products: Doc[], term: string, traits: ProductTraits<Doc>, currency: string, outOfStockThreshold: number): ProductRow[] {
  const entries = catalogueEntries(searchProducts(products, term, traits), traits, { currency });
  const counts = new Map<string, number>();
  for (const { product } of entries) { const id = traits.getId(product); counts.set(id, (counts.get(id) ?? 0) + 1); }
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
      priceText: current ? moneyToMajor(current).toFixed(minorUnitDigits(current.currency)) : '',
      stockText: variant.stock.quantity == null ? '' : String(variant.stock.quantity), managed: variant.stock.quantity != null,
      editable: counts.get(traits.getId(product)) === 1,
      stockTarget: stockTarget((product as { variants?: ({ id: string | number } & VendureVariantStock)[] }).variants?.find(v => String(v.id) === variant.id), outOfStockThreshold),
    };
  });
}
