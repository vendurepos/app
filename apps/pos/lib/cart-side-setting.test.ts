import { beforeEach, expect, it } from 'vitest';
import { loadCartSide, saveCartSide } from './cart-side-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
});

it('is right when nothing, or anything but left, is stored', () => {
  expect(loadCartSide(store)).toBe('right');
  store.setItem('vendurepos.till.cartSide', 'x');
  expect(loadCartSide(store)).toBe('right');
});

it('round-trips left then right', () => {
  saveCartSide('left', store);
  expect(loadCartSide(store)).toBe('left');
  saveCartSide('right', store);
  expect(loadCartSide(store)).toBe('right');
});
