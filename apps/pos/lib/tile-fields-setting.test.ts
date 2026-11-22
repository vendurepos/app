import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_TILE_FIELDS } from '@tallyui/pos';
import { loadTileFields, saveTileFields, TILE_FIELDS_KEY } from './tile-fields-setting';
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

it('the default tile when nothing is stored', () => {
  expect(loadTileFields(store)).toEqual(DEFAULT_TILE_FIELDS);
});

it('saves and loads the tile fields under TILE_FIELDS_KEY', () => {
  const fields = { ...DEFAULT_TILE_FIELDS, sku: true, price: false };
  saveTileFields(fields, store);
  expect(store.getItem(TILE_FIELDS_KEY)).toBe(JSON.stringify(fields));
  expect(loadTileFields(store)).toEqual(fields);
});

it('a stored value that is not JSON or not an object reads as the default tile', () => {
  for (const value of ['not json', '[]', 'null']) {
    store.setItem(TILE_FIELDS_KEY, value);
    expect(loadTileFields(store)).toEqual(DEFAULT_TILE_FIELDS);
  }
});

it('a stored object keeps its known fields over the default and drops unknown keys', () => {
  store.setItem(TILE_FIELDS_KEY, '{"sku":true,"bogus":true}');
  const fields = loadTileFields(store);
  expect(fields).toEqual({ ...DEFAULT_TILE_FIELDS, sku: true });
  expect(fields).not.toHaveProperty('bogus');
});
