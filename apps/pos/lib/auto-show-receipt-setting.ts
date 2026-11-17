import { defaultStore, type KeyValueStore } from './session';

const AUTO_SHOW_RECEIPT_KEY = 'vendurepos.till.autoShowReceipt';

/** v2's "Automatically show receipt after checkout": on unless the till turned it off (CHECKLIST 9.10). */
export function loadAutoShowReceipt(store: KeyValueStore = defaultStore()): boolean {
  return store.getItem(AUTO_SHOW_RECEIPT_KEY) !== '0';
}

export function saveAutoShowReceipt(on: boolean, store: KeyValueStore = defaultStore()): void {
  store.setItem(AUTO_SHOW_RECEIPT_KEY, on ? '1' : '0');
}
