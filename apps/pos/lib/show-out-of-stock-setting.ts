import { defaultStore, type KeyValueStore } from './session';

const SHOW_OUT_OF_STOCK_KEY = 'vendurepos.till.showOutOfStock';

export function loadShowOutOfStock(store: KeyValueStore = defaultStore()): boolean {
  return store.getItem(SHOW_OUT_OF_STOCK_KEY) === '1';
}

export function saveShowOutOfStock(on: boolean, store: KeyValueStore = defaultStore()): void {
  store.setItem(SHOW_OUT_OF_STOCK_KEY, on ? '1' : '0');
}
