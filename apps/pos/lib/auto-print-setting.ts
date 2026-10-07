import { defaultStore, type KeyValueStore } from './session';

export const AUTO_PRINT_KEY = 'vendurepos.till.autoPrint';

export function loadAutoPrint(store: KeyValueStore = defaultStore()): boolean {
  return store.getItem(AUTO_PRINT_KEY) === '1';
}

export function saveAutoPrint(on: boolean, store: KeyValueStore = defaultStore()): void {
  store.setItem(AUTO_PRINT_KEY, on ? '1' : '0');
}
