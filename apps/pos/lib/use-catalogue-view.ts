import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { DEFAULT_CATALOGUE_VIEW_STATE, type CatalogueViewState } from '@tallyui/pos';
import { loadTileSize } from './tile-size-setting';

/** The Products view, controlled so the tile size from Settings applies when the till comes back into focus. */
export function useCatalogueView(): { viewState: CatalogueViewState; onStateChange: (state: CatalogueViewState) => void } {
  const [viewState, setViewState] = useState(() => ({
    ...DEFAULT_CATALOGUE_VIEW_STATE, gridColumns: loadTileSize(),
  }));
  useFocusEffect(useCallback(() => {
    const gridColumns = loadTileSize();
    setViewState((state) => state.gridColumns === gridColumns ? state : { ...state, gridColumns });
  }, []));
  return { viewState, onStateChange: setViewState };
}
