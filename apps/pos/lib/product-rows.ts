import type { ProductTraits } from '@tallyui/core';
import { catalogueEntries, searchProducts, variantPriceLabel } from '@tallyui/pos';

/** One variant's row in the Products panel (CHECKLIST 10.2), as the panel shows it. */
export interface ProductRow { id: string; name: string; sku: string; price: string; stock: string }

/** One row per variant in catalogue order, filtered by the till's own search; an exact SKU or barcode keeps that variant alone. */
export function productRows<Doc>(products: Doc[], term: string, traits: ProductTraits<Doc>, currency: string): ProductRow[] {
  const entries = catalogueEntries(searchProducts(products, term, traits), traits, { currency });
  const code = term.trim().toLowerCase();
  const exact = code ? entries.filter(({ variant }) => variant.sku?.toLowerCase() === code || variant.barcode?.toLowerCase() === code) : [];
  return (exact.length ? exact : entries).map(({ product, variant }) => {
    const name = traits.getName(product);
    const option = variant.title?.startsWith(name) ? variant.title.slice(name.length).trim() : variant.title ?? '';
    return {
      id: variant.id, name: option ? `${name} · ${option}` : name,
      sku: variant.sku ?? '—', price: variantPriceLabel(variant, currency) ?? '—',
      stock: variant.stock.quantity == null ? '—' : String(variant.stock.quantity),
    };
  });
}
