import { DEMO_MODE } from './demo/mode';
import { defaultStore, type KeyValueStore } from './session';

export const PRICE_EDIT_KEY = 'vendurepos.till.priceEdit';

export function loadPriceEditAllowed(store: KeyValueStore = defaultStore(), fallback = DEMO_MODE): boolean {
  const value = store.getItem(PRICE_EDIT_KEY);
  return value === '1' ? true : value === '0' ? false : fallback;
}

export function savePriceEditAllowed(allowed: boolean, store: KeyValueStore = defaultStore()): void {
  store.setItem(PRICE_EDIT_KEY, allowed ? '1' : '0');
}
