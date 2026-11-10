import type { CatalogueGridColumns } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const TILE_SIZE_KEY = 'vendurepos.till.tileSize';
/** Auto, then 2 to 8 tiles a row: TallyUI's CatalogueGridColumns. */
export const TILE_SIZES: readonly CatalogueGridColumns[] = ['auto', 2, 3, 4, 5, 6, 7, 8];

/** The stored tile size for this till, or 'auto' when none or not one of TILE_SIZES. */
export function loadTileSize(store: KeyValueStore = defaultStore()): CatalogueGridColumns {
  const value = store.getItem(TILE_SIZE_KEY);
  return TILE_SIZES.find((size) => String(size) === value) ?? 'auto';
}

export function saveTileSize(size: CatalogueGridColumns, store: KeyValueStore = defaultStore()): void {
  store.setItem(TILE_SIZE_KEY, String(size));
}
