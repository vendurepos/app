import { beforeEach, expect, it } from 'vitest';
import { loadProductSort, loadProductSortOption, saveProductSortOption, PRODUCT_SORT_KEY, PRODUCT_SORT_OPTIONS } from './product-sort-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
});

it('Name A–Z by default', () => {
  expect(loadProductSortOption(store)).toBe('name-asc');
  expect(loadProductSort(store)).toEqual({ field: 'name', dir: 'asc' });
});

it('saves and loads each product sort', () => {
  for (const option of PRODUCT_SORT_OPTIONS) {
    saveProductSortOption(option.value, store);
    expect(store.getItem(PRODUCT_SORT_KEY)).toBe(option.value);
    expect(loadProductSortOption(store)).toBe(option.value);
    expect(loadProductSort(store)).toEqual(option.sort);
  }
});

it('a stored value it does not know reads as Name A–Z', () => {
  for (const value of ['price', 'name-desc', '']) {
    store.setItem(PRODUCT_SORT_KEY, value);
    expect(loadProductSortOption(store)).toBe('name-asc');
  }
});
