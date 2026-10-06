import { beforeEach, expect, it } from 'vitest';
import { loadPriceEditAllowed, savePriceEditAllowed } from './price-edit-setting';
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

it('off by default on a real store, on in the demo', () => {
  expect(loadPriceEditAllowed(store, false)).toBe(false);
  expect(loadPriceEditAllowed(store, true)).toBe(true);
});

it('saving overrides the default', () => {
  savePriceEditAllowed(true, store);
  expect(loadPriceEditAllowed(store, false)).toBe(true);
  savePriceEditAllowed(false, store);
  expect(loadPriceEditAllowed(store, true)).toBe(false);
});
