import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { DEFAULT_CATALOGUE_VIEW_STATE, TILE_FIELDS, type CatalogueViewState, type TileFields } from '@tallyui/pos';
import { loadTileSize } from './tile-size-setting';
import { loadTileFields } from './tile-fields-setting';
import { loadProductSort } from './product-sort-setting';
import { loadCategoryBrowse, loadVariationsStyle, type CategoryBrowse, type VariationsStyle } from './catalogue-browse-setting';

/** The Products view, controlled so the tile size, tile fields, sort, Browse by and Variations from Settings apply when the till comes back into focus or the Settings panel closes. */
export function useCatalogueView(settingsOpen = false): {
  viewState: CatalogueViewState; onStateChange: (state: CatalogueViewState) => void; tileFields: TileFields;
  categoryBrowse: CategoryBrowse; variationsStyle: VariationsStyle;
} {
  const [viewState, setViewState] = useState<CatalogueViewState>(() => ({
    ...DEFAULT_CATALOGUE_VIEW_STATE, gridColumns: loadTileSize(), sort: loadProductSort(),
  }));
  const [tileFields, setTileFields] = useState<TileFields>(() => loadTileFields());
  const [categoryBrowse, setCategoryBrowse] = useState<CategoryBrowse>(() => loadCategoryBrowse());
  const [variationsStyle, setVariationsStyle] = useState<VariationsStyle>(() => loadVariationsStyle());
  const reread = useCallback(() => {
    const gridColumns = loadTileSize();
    const sort = loadProductSort();
    setViewState((state) => state.gridColumns === gridColumns && state.sort?.field === sort.field && state.sort?.dir === sort.dir
      ? state : { ...state, gridColumns, sort });
    const fields = loadTileFields();
    setTileFields((current) => TILE_FIELDS.some((field) => current[field] !== fields[field]) ? fields : current);
    // Plain strings: React keeps the state when the value is the same.
    setCategoryBrowse(loadCategoryBrowse());
    setVariationsStyle(loadVariationsStyle());
  }, []);
  useFocusEffect(reread);
  // Settings as a till panel never moves the focus: its close re-reads too (CHECKLIST 9.1).
  useEffect(() => { if (!settingsOpen) reread(); }, [reread, settingsOpen]);
  return { viewState, onStateChange: setViewState, tileFields, categoryBrowse, variationsStyle };
}
