import { beforeEach, expect, it } from 'vitest';
import {
  CATEGORY_BROWSE_KEY, CATEGORY_BROWSE_OPTIONS, VARIATIONS_STYLE_KEY, VARIATIONS_STYLE_OPTIONS,
  loadCategoryBrowse, loadVariationsStyle, saveCategoryBrowse, saveVariationsStyle,
} from './catalogue-browse-setting';
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

it('category tiles and Open in place by default', () => {
  expect(loadCategoryBrowse(store)).toBe('tiles');
  expect(loadVariationsStyle(store)).toBe('drill');
});

it('saves and loads each Browse by and Variations choice under its key', () => {
  for (const option of CATEGORY_BROWSE_OPTIONS) {
    saveCategoryBrowse(option.value, store);
    expect(store.getItem(CATEGORY_BROWSE_KEY)).toBe(option.value);
    expect(loadCategoryBrowse(store)).toBe(option.value);
  }
  for (const option of VARIATIONS_STYLE_OPTIONS) {
    saveVariationsStyle(option.value, store);
    expect(store.getItem(VARIATIONS_STYLE_KEY)).toBe(option.value);
    expect(loadVariationsStyle(store)).toBe(option.value);
  }
});

it('a stored value it does not know reads as the default', () => {
  store.setItem(CATEGORY_BROWSE_KEY, 'bogus');
  store.setItem(VARIATIONS_STYLE_KEY, 'bogus');
  expect(loadCategoryBrowse(store)).toBe('tiles');
  expect(loadVariationsStyle(store)).toBe('drill');
});
