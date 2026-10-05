import { beforeEach, expect, it, vi } from 'vitest';
import { loadScannerMinLength, saveScannerMinLength, SCANNER_MIN_LENGTH_KEY } from './scanner-settings';
import type { KeyValueStore } from './session';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
});

it('nothing stored: the default 8', () => {
  expect(loadScannerMinLength(store)).toBe(8);
});

it('a stored whole number in range is used', () => {
  store.setItem(SCANNER_MIN_LENGTH_KEY, '5');
  expect(loadScannerMinLength(store)).toBe(5);
});

it('out of range, not whole or not a number falls back to 8', () => {
  for (const value of ['3', '33', '5.5', 'abc', '']) {
    store.setItem(SCANNER_MIN_LENGTH_KEY, value);
    expect(loadScannerMinLength(store)).toBe(8);
  }
});

it('save stores a valid value and refuses an invalid one', () => {
  expect(saveScannerMinLength(6, store)).toBe(true);
  expect(loadScannerMinLength(store)).toBe(6);
  expect(saveScannerMinLength(2, store)).toBe(false);
  expect(loadScannerMinLength(store)).toBe(6);
  expect(saveScannerMinLength(4.5, store)).toBe(false);
  expect(loadScannerMinLength(store)).toBe(6);
});
