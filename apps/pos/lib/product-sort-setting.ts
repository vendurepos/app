import type { ProductSort } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const PRODUCT_SORT_KEY = 'vendurepos.till.productSort';
/** The till's sort choices, after v2's Sort by; the first is the default. */
export const PRODUCT_SORT_OPTIONS = [
  { value: 'name-asc', label: 'Name A–Z', sort: { field: 'name', dir: 'asc' } },
  { value: 'price-asc', label: 'Price low–high', sort: { field: 'price', dir: 'asc' } },
  { value: 'price-desc', label: 'Price high–low', sort: { field: 'price', dir: 'desc' } },
  { value: 'stock-desc', label: 'Stock high–low', sort: { field: 'stock', dir: 'desc' } },
] as const satisfies readonly { value: string; label: string; sort: ProductSort }[];
export type ProductSortOption = (typeof PRODUCT_SORT_OPTIONS)[number]['value'];

/** The stored choice for this till, or 'name-asc' when none or not one of PRODUCT_SORT_OPTIONS. */
export function loadProductSortOption(store: KeyValueStore = defaultStore()): ProductSortOption {
  const value = store.getItem(PRODUCT_SORT_KEY);
  return PRODUCT_SORT_OPTIONS.find((option) => option.value === value)?.value ?? 'name-asc';
}

export function saveProductSortOption(option: ProductSortOption, store: KeyValueStore = defaultStore()): void {
  store.setItem(PRODUCT_SORT_KEY, option);
}

/** The ProductSort of the stored choice (a fresh object each call). */
export function loadProductSort(store: KeyValueStore = defaultStore()): ProductSort {
  const value = loadProductSortOption(store);
  const option = PRODUCT_SORT_OPTIONS.find((option) => option.value === value)!;
  return { ...option.sort };
}
