import { defaultStore, type KeyValueStore } from './session';

/** The per-device settings of v2's one Cart settings sheet (CHECKLIST 9.10), spread here over General and Printing. */
export const CART_SETTING_KEYS = [
  'vendurepos.till.cartSide',
  'vendurepos.till.cartSort',
  'vendurepos.till.cartColumns',
  'vendurepos.till.openOrdersPosition',
  'vendurepos.till.quickDiscounts',
  'vendurepos.till.autoShowReceipt',
  'vendurepos.till.autoPrint',
] as const;

/** v2's Restore Default Settings: removes each cart setting, so each reads its own default again. */
export function resetCartSettings(store: KeyValueStore = defaultStore()): void {
  for (const key of CART_SETTING_KEYS) store.removeItem(key);
}
