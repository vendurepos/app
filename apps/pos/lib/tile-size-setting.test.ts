import { beforeEach, expect, it } from 'vitest';
import { loadTileSize, saveTileSize, TILE_SIZE_KEY, TILE_SIZES } from './tile-size-setting';
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

it('Auto by default', () => {
  expect(loadTileSize(store)).toBe('auto');
});

it('saves and loads each tile size', () => {
  for (const size of TILE_SIZES) {
    saveTileSize(size, store);
    expect(store.getItem(TILE_SIZE_KEY)).toBe(String(size));
    expect(loadTileSize(store)).toBe(size);
  }
});

it('a stored value it does not know reads as Auto', () => {
  for (const value of ['1', '9', '3.5', 'big', '']) {
    store.setItem(TILE_SIZE_KEY, value);
    expect(loadTileSize(store)).toBe('auto');
  }
});
