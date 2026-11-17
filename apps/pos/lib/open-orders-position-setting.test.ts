import { beforeEach, expect, it } from 'vitest';
import { loadOpenOrdersPosition, saveOpenOrdersPosition } from './open-orders-position-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
});

it('is bottom when nothing, or anything but top, is stored', () => {
  expect(loadOpenOrdersPosition(store)).toBe('bottom');
  store.setItem('vendurepos.till.openOrdersPosition', 'x');
  expect(loadOpenOrdersPosition(store)).toBe('bottom');
});

it('round-trips top then bottom', () => {
  saveOpenOrdersPosition('top', store);
  expect(loadOpenOrdersPosition(store)).toBe('top');
  saveOpenOrdersPosition('bottom', store);
  expect(loadOpenOrdersPosition(store)).toBe('bottom');
});
