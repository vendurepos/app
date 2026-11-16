import { useSyncExternalStore } from 'react';
import { UI_SCALES, type UiScale } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const SCALE_KEY = 'vendurepos.ui.scale';
const listeners = new Set<() => void>();

export function loadScale(store: KeyValueStore = defaultStore()): UiScale {
  const value = store.getItem(SCALE_KEY);
  return UI_SCALES.find((scale) => scale === value) ?? 'auto';
}

export function saveScale(scale: UiScale, store: KeyValueStore = defaultStore()): void {
  store.setItem(SCALE_KEY, scale);
  for (const listener of listeners) listener();
}

export function subscribeScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useStoredScale(): UiScale {
  return useSyncExternalStore(subscribeScale, () => loadScale(), () => 'auto');
}
