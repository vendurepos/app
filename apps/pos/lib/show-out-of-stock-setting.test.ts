import { beforeEach, expect, it } from 'vitest';
import { loadShowOutOfStock, saveShowOutOfStock } from './show-out-of-stock-setting';
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

it('is off when nothing is stored', () => {
  expect(loadShowOutOfStock(store)).toBe(false);
});

it('round-trips true then false', () => {
  saveShowOutOfStock(true, store);
  expect(loadShowOutOfStock(store)).toBe(true);
  saveShowOutOfStock(false, store);
  expect(loadShowOutOfStock(store)).toBe(false);
});
