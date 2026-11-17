import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { DEFAULT_PRODUCT_FILTERS, type ProductFilters } from '@tallyui/components';
import { loadShowOutOfStock } from './show-out-of-stock-setting';

/**
 * The Products filters, controlled so the In Stock pill starts off when Settings shows out-of-stock products (v2's
 * product-grid setting, CHECKLIST 9.9). A cashier's own tap on the pill stands until the setting itself changes.
 */
export function useCatalogueFilters(): { filters: ProductFilters; onFiltersChange: (filters: ProductFilters) => void } {
  const shown = useRef(loadShowOutOfStock());
  const [filters, setFilters] = useState<ProductFilters>(() => ({ ...DEFAULT_PRODUCT_FILTERS, inStock: !shown.current }));
  useFocusEffect(useCallback(() => {
    const next = loadShowOutOfStock();
    if (next === shown.current) return;
    shown.current = next;
    setFilters((current) => ({ ...current, inStock: !next }));
  }, []));
  return { filters, onFiltersChange: setFilters };
}
