import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { DEFAULT_CATALOGUE_VIEW_STATE, type CatalogueViewState } from '@tallyui/pos';
import { loadTileSize } from './tile-size-setting';
import { loadProductSort } from './product-sort-setting';

/** The Products view, controlled so the tile size and sort from Settings apply when the till comes back into focus. */
export function useCatalogueView(): { viewState: CatalogueViewState; onStateChange: (state: CatalogueViewState) => void } {
  const [viewState, setViewState] = useState<CatalogueViewState>(() => ({
    ...DEFAULT_CATALOGUE_VIEW_STATE, gridColumns: loadTileSize(), sort: loadProductSort(),
  }));
  useFocusEffect(useCallback(() => {
    const gridColumns = loadTileSize();
    const sort = loadProductSort();
    setViewState((state) => state.gridColumns === gridColumns && state.sort?.field === sort.field && state.sort?.dir === sort.dir
      ? state : { ...state, gridColumns, sort });
  }, []));
  return { viewState, onStateChange: setViewState };
}
