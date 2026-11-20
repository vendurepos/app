import type { CartColumnSettings } from '@tallyui/components';
import { defaultStore, type KeyValueStore } from './session';

const CART_COLUMNS_KEY = 'vendurepos.till.cartColumns';

export function loadCartColumns(store: KeyValueStore = defaultStore()): CartColumnSettings {
  let value: unknown;
  try { value = JSON.parse(store.getItem(CART_COLUMNS_KEY) ?? 'null'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const columns: CartColumnSettings = {};
  for (const [column, fields] of [
    ['quantity', ['show', 'split']], ['image', ['show']], ['name', ['show', 'sku']],
    ['sku', ['show']], ['price', ['show']], ['total', ['show']],
  ] as const) {
    const stored = (value as Record<string, unknown>)[column];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
    const kept: Record<string, boolean> = {};
    for (const field of fields) {
      const flag = (stored as Record<string, unknown>)[field];
      if (typeof flag === 'boolean') kept[field] = flag;
    }
    if (Object.keys(kept).length) columns[column] = kept;
  }
  return columns;
}

export function saveCartColumns(columns: CartColumnSettings, store: KeyValueStore = defaultStore()): void {
  store.setItem(CART_COLUMNS_KEY, JSON.stringify(columns));
}

export function cartColumnShown(columns: CartColumnSettings) {
  return {
    quantity: columns.quantity?.show ?? true, quantitySplit: columns.quantity?.split ?? false,
    image: columns.image?.show ?? false, name: columns.name?.show ?? true,
    nameSku: columns.name?.sku ?? false, sku: columns.sku?.show ?? false,
    price: columns.price?.show ?? true, total: columns.total?.show ?? true,
  };
}
