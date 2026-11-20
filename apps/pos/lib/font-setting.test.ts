import { beforeEach, expect, it, vi } from 'vitest';
import { FONT_SETTINGS } from '@tallyui/theme';
import { FONT_KEY, loadFont, saveFont, subscribeFont } from './font-setting';
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

it('auto by default', () => {
  expect(loadFont(store)).toBe('auto');
});

it('saves and loads each font', () => {
  for (const font of FONT_SETTINGS) {
    saveFont(font, store);
    expect(store.getItem(FONT_KEY)).toBe(font);
    expect(loadFont(store)).toBe(font);
  }
});

it('an unknown stored value reads as auto', () => {
  store.setItem(FONT_KEY, 'unknown');
  expect(loadFont(store)).toBe('auto');
});

it('notifies on save and stops after unsubscribe', () => {
  const listener = vi.fn(() => expect(loadFont(store)).toBe('manrope'));
  const unsubscribe = subscribeFont(listener);
  saveFont('manrope', store);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  saveFont('auto', store);
  expect(listener).toHaveBeenCalledTimes(1);
});
