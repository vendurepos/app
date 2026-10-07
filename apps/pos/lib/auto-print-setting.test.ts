import { beforeEach, expect, it } from 'vitest';
import { loadAutoPrint, saveAutoPrint } from './auto-print-setting';
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
  expect(loadAutoPrint(store)).toBe(false);
});

it('round-trips true then false', () => {
  saveAutoPrint(true, store);
  expect(loadAutoPrint(store)).toBe(true);
  saveAutoPrint(false, store);
  expect(loadAutoPrint(store)).toBe(false);
});
