import { beforeEach, expect, it, vi } from 'vitest';
import { UI_SCALES } from '@tallyui/pos';
import { loadScale, saveScale, SCALE_KEY, subscribeScale } from './scale-setting';
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
  expect(loadScale(store)).toBe('auto');
});

it('saves and loads each scale', () => {
  for (const scale of UI_SCALES) {
    saveScale(scale, store);
    expect(store.getItem(SCALE_KEY)).toBe(scale);
    expect(loadScale(store)).toBe(scale);
  }
});

it('a stored value it does not know reads as auto', () => {
  for (const value of ['Compact', 'huge', '']) {
    store.setItem(SCALE_KEY, value);
    expect(loadScale(store)).toBe('auto');
  }
});

it('notifies a listener once on save and stops after unsubscribe', () => {
  const listener = vi.fn(() => expect(loadScale(store)).toBe('compact'));
  const unsubscribe = subscribeScale(listener);
  saveScale('compact', store);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  saveScale('spacious', store);
  expect(listener).toHaveBeenCalledTimes(1);
});
