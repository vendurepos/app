import { UI_THEMES, type UiTheme } from '@tallyui/pos';
import { Uniwind } from 'uniwind';
import { defaultStore, type KeyValueStore } from './session';

export const THEME_KEY = 'vendurepos.ui.theme';

export function loadTheme(store: KeyValueStore = defaultStore()): UiTheme {
  const value = store.getItem(THEME_KEY);
  return UI_THEMES.find((theme) => theme === value) ?? 'system';
}

export function saveTheme(theme: UiTheme, store: KeyValueStore = defaultStore()): void {
  store.setItem(THEME_KEY, theme);
}

export function applyTheme(theme: UiTheme): void {
  Uniwind.setTheme(theme);
}
