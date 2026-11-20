import { useSyncExternalStore } from 'react';
import { expect, it, vi } from 'vitest';
import { clearScannerError, createScanDedupe, liveScannerSettings, reportScannerError, useScannerError } from './device-scanner';
import { saveScannerAffixes, saveScannerMinLength } from './scanner-settings';
import type { KeyValueStore } from './session';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('react', async (importActual) => ({
  ...await importActual<typeof import('react')>(),
  useSyncExternalStore: vi.fn((_subscribe: unknown, snapshot: () => unknown) => snapshot()),
}));

it('reads prefix, suffix and minimum length again after Settings saves', () => {
  const data = new Map<string, string>();
  const store: KeyValueStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
  const settings = liveScannerSettings(store);
  expect({ ...settings }).toEqual({ prefix: '', suffix: '', minChars: 8 });
  saveScannerAffixes({ prefix: '*', suffix: '#' }, store);
  saveScannerMinLength(12, store);
  expect({ ...settings }).toEqual({ prefix: '*', suffix: '#', minChars: 12 });
});
it('drops only cross-source repeats within the window and preserves handler results', () => {
  let time = 0;
  const dedupe = createScanDedupe(500, () => time);
  const handle = vi.fn(() => true);
  expect(dedupe.run('TALLY-MUG', 'hid-pos', handle)).toBe(true);
  expect(handle).toHaveBeenCalledWith('TALLY-MUG');
  handle.mockClear();
  time = 100;
  expect(dedupe.run('TALLY-MUG', 'wedge', handle)).toBeNull();
  expect(handle).not.toHaveBeenCalled();
  time = 501;
  expect(dedupe.run('TALLY-MUG', 'wedge', handle)).toBe(true);
  time = 601;
  expect(dedupe.run('TALLY-MUG', 'wedge', handle)).toBe(true);
  expect(handle).toHaveBeenCalledTimes(2);
});
it('matches the leading-zero EAN-13 with its UPC-A twin across kinds', () => {
  let time = 0;
  const dedupe = createScanDedupe(500, () => time);
  const handle = vi.fn();
  dedupe.run('0012345678905', 'hid-pos', handle);
  time = 100;
  expect(dedupe.run('012345678905', 'wedge', handle)).toBeNull();
  expect(handle).toHaveBeenCalledTimes(1);
});
it('notifies for errors and clearing, ignores cancellation, and has a null server snapshot', () => {
  clearScannerError();
  expect(useScannerError()).toBeNull();
  const [subscribe, snapshot, serverSnapshot] = vi.mocked(useSyncExternalStore).mock.calls.at(-1)!;
  const listener = vi.fn();
  const unsubscribe = subscribe(listener);
  reportScannerError(new Error('Device busy'), { phase: 'connect', cancelled: false });
  expect(snapshot()).toBe('Device busy');
  expect(listener).toHaveBeenCalledTimes(1);
  reportScannerError(new Error('Cancelled'), { phase: 'connect', cancelled: true });
  expect(snapshot()).toBe('Device busy');
  expect(listener).toHaveBeenCalledTimes(1);
  reportScannerError('Could not reopen', { phase: 'reopen', cancelled: false });
  expect(snapshot()).toBe('Could not reopen');
  expect(listener).toHaveBeenCalledTimes(2);
  expect(serverSnapshot!()).toBeNull();
  clearScannerError();
  expect(snapshot()).toBeNull();
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
});
