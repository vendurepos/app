import type { CartColumnSettings } from '@tallyui/components';
import { defaultStore, type KeyValueStore } from './session';

const CART_COLUMNS_KEY = 'vendurepos.till.cartColumns';

/** The columns this app offers, in v2's default order; TallyUI's Regular Price column is not one of them (2.5). */
export const CART_COLUMN_ORDER = ['quantity', 'image', 'name', 'sku', 'price', 'total'] as const;
export type CartColumn = (typeof CART_COLUMN_ORDER)[number];

/** A saved order kept as listed: unknown and repeated ids dropped, missing ones appended in the default order. */
function fillOrder(order: unknown): CartColumn[] {
  const known = (id: unknown): id is CartColumn => (CART_COLUMN_ORDER as readonly unknown[]).includes(id);
  return [...new Set([...(Array.isArray(order) ? order.filter(known) : []), ...CART_COLUMN_ORDER])];
}

/** The columns with `column` moved one place up (-1) or down (1); at either end they come back unchanged. */
export function moveCartColumn(columns: CartColumnSettings, column: CartColumn, by: -1 | 1): CartColumnSettings {
  const order = fillOrder(columns.order);
  const from = order.indexOf(column);
  const to = from + by;
  if (to < 0 || to >= order.length) return columns;
  [order[from], order[to]] = [order[to], order[from]];
  return { ...columns, order };
}

/** The saved columns, always with a full `order` (v2's drag order), so a value saved before 9.10b still loads. */
export function loadCartColumns(store: KeyValueStore = defaultStore()): CartColumnSettings {
  let value: unknown;
  try { value = JSON.parse(store.getItem(CART_COLUMNS_KEY) ?? 'null'); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const columns: CartColumnSettings = { order: fillOrder((value as { order?: unknown }).order) };
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
  const order = fillOrder(columns.order);
  store.setItem(CART_COLUMNS_KEY, JSON.stringify({
    ...columns, order: order.every((id, index) => id === CART_COLUMN_ORDER[index]) ? undefined : order,
  }));
}

export function cartColumnShown(columns: CartColumnSettings) {
  return {
    quantity: columns.quantity?.show ?? true, quantitySplit: columns.quantity?.split ?? false,
    image: columns.image?.show ?? false, name: columns.name?.show ?? true,
    nameSku: columns.name?.sku ?? false, sku: columns.sku?.show ?? false,
    price: columns.price?.show ?? true, total: columns.total?.show ?? true,
  };
}
