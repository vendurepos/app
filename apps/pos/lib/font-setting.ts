import { useSyncExternalStore } from 'react';
import { FONT_SETTINGS } from '@tallyui/theme';
import { defaultStore, type KeyValueStore } from './session';

export const FONT_KEY = 'vendurepos.ui.font';
export type FontSetting = (typeof FONT_SETTINGS)[number];
export const FONT_LABELS: Record<FontSetting, string> = {
  auto: 'Match theme', system: 'System',
  instrument: 'DM Sans · Instrument Serif', grotesk: 'Space Grotesk',
  fraunces: 'DM Sans · Fraunces', manrope: 'Manrope',
};
const listeners = new Set<() => void>();

export function loadFont(store: KeyValueStore = defaultStore()): FontSetting {
  const value = store.getItem(FONT_KEY);
  return FONT_SETTINGS.find((font) => font === value) ?? 'auto';
}
export function saveFont(font: FontSetting, store: KeyValueStore = defaultStore()): void {
  store.setItem(FONT_KEY, font);
  for (const listener of listeners) listener();
}
export function subscribeFont(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useStoredFont(): FontSetting {
  return useSyncExternalStore(subscribeFont, () => loadFont(), () => 'auto');
}
