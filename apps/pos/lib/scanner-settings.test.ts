import { beforeEach, expect, it, vi } from 'vitest';
import {
  loadScannerMinLength, saveScannerMinLength, SCANNER_MIN_LENGTH_KEY,
  loadScannerAffixes, saveScannerAffixes, stripScanAffixes, loadScanSounds, saveScanSounds,
  SCANNER_PREFIX_KEY, SCANNER_SUFFIX_KEY, SCAN_SOUNDS_KEY,
} from './scanner-settings';
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

it('strips the stored prefix and suffix from a scan', () => {
  saveScannerAffixes({ prefix: '*', suffix: '#' }, store);
  expect(stripScanAffixes('*2000000000015#', loadScannerAffixes(store))).toBe('2000000000015');
});

it('leaves a scan without the prefix or suffix as it is', () => {
  expect(stripScanAffixes('20*000#0000015', { prefix: '*', suffix: '#' })).toBe('20*000#0000015');
});

it('strips a prefix and suffix of more than one character', () => {
  expect(stripScanAffixes(']C12000000000015%%', { prefix: ']C1', suffix: '%%' })).toBe('2000000000015');
});

it('with no prefix or suffix every scan is unchanged', () => {
  for (const code of ['', '2000000000015', '*2000000000015#', ' AbC ']) {
    expect(stripScanAffixes(code, { prefix: '', suffix: '' })).toBe(code);
  }
});

it('a scan that is only the prefix and suffix strips to nothing', () => {
  expect(stripScanAffixes('*#', { prefix: '*', suffix: '#' })).toBe('');
});

it('no prefix, no suffix and no sounds by default', () => {
  expect(loadScannerAffixes(store)).toEqual({ prefix: '', suffix: '' });
  expect(loadScanSounds(store)).toBe(false);
});

it('saves and loads the prefix and suffix, and an empty one is removed', () => {
  saveScannerAffixes({ prefix: '*', suffix: '#' }, store);
  expect(loadScannerAffixes(store)).toEqual({ prefix: '*', suffix: '#' });
  saveScannerAffixes({ prefix: '', suffix: '#' }, store);
  expect(store.getItem(SCANNER_PREFIX_KEY)).toBeNull();
  expect(loadScannerAffixes(store)).toEqual({ prefix: '', suffix: '#' });
  saveScannerAffixes({ prefix: '*', suffix: '' }, store);
  expect(store.getItem(SCANNER_SUFFIX_KEY)).toBeNull();
  expect(loadScannerAffixes(store)).toEqual({ prefix: '*', suffix: '' });
});

it('saves and loads scan sounds', () => {
  saveScanSounds(true, store);
  expect(store.getItem(SCAN_SOUNDS_KEY)).toBe('1');
  expect(loadScanSounds(store)).toBe(true);
  saveScanSounds(false, store);
  expect(loadScanSounds(store)).toBe(false);
  store.setItem(SCAN_SOUNDS_KEY, 'true');
  expect(loadScanSounds(store)).toBe(false);
});
