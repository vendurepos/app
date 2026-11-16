import { beforeEach, expect, it } from 'vitest';
import { UI_THEMES } from '@tallyui/pos';
import { loadTheme, saveTheme, THEME_KEY } from './theme-setting';
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

it('system by default', () => {
  expect(loadTheme(store)).toBe('system');
});

it('saves and loads each theme', () => {
  for (const theme of UI_THEMES) {
    saveTheme(theme, store);
    expect(store.getItem(THEME_KEY)).toBe(theme);
    expect(loadTheme(store)).toBe(theme);
  }
});

it('a stored value it does not know reads as system', () => {
  for (const value of ['Dark', 'blue', '']) {
    store.setItem(THEME_KEY, value);
    expect(loadTheme(store)).toBe('system');
  }
});
