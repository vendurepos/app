import { beforeEach, expect, it } from 'vitest';
import { loadAutoShowReceipt, saveAutoShowReceipt } from './auto-show-receipt-setting';
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

it('is on when nothing is stored', () => {
  expect(loadAutoShowReceipt(store)).toBe(true);
});

it('round-trips false then true', () => {
  saveAutoShowReceipt(false, store);
  expect(loadAutoShowReceipt(store)).toBe(false);
  saveAutoShowReceipt(true, store);
  expect(loadAutoShowReceipt(store)).toBe(true);
});
