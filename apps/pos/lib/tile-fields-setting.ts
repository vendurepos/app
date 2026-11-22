import { DEFAULT_TILE_FIELDS, normalizeTileFields, type TileFields } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const TILE_FIELDS_KEY = 'vendurepos.till.tileFields';

/** The stored tile fields for this till (TallyUI's normalizeTileFields), or DEFAULT_TILE_FIELDS when none, unreadable or not an object. */
export function loadTileFields(store: KeyValueStore = defaultStore()): TileFields {
  const raw = store.getItem(TILE_FIELDS_KEY);
  if (raw === null) return DEFAULT_TILE_FIELDS;
  try {
    return normalizeTileFields(JSON.parse(raw)) ?? DEFAULT_TILE_FIELDS;
  } catch {
    return DEFAULT_TILE_FIELDS;
  }
}

export function saveTileFields(fields: TileFields, store: KeyValueStore = defaultStore()): void {
  store.setItem(TILE_FIELDS_KEY, JSON.stringify(fields));
}
