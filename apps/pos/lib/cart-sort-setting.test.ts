import { beforeEach, expect, it } from 'vitest';
import { loadCartSort, saveCartSort, sortCartLines } from './cart-sort-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
});

it('is oldest when nothing, or anything but newest, is stored', () => {
  expect(loadCartSort(store)).toBe('oldest');
  store.setItem('vendurepos.till.cartSort', 'x');
  expect(loadCartSort(store)).toBe('oldest');
});

it('round-trips newest then oldest', () => {
  saveCartSort('newest', store);
  expect(loadCartSort(store)).toBe('newest');
  saveCartSort('oldest', store);
  expect(loadCartSort(store)).toBe('oldest');
});

it.each(['newest', 'oldest'] as const)('copies the lines with %s at top without changing the input', (sort) => {
  const input = ['a', 'b', 'c'];
  const result = sortCartLines(input, sort);
  expect(result).toEqual(sort === 'newest' ? ['c', 'b', 'a'] : ['a', 'b', 'c']);
  expect(input).toEqual(['a', 'b', 'c']);
  expect(result).not.toBe(input);
});
