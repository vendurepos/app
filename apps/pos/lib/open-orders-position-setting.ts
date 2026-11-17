import { defaultStore, type KeyValueStore } from './session';

const OPEN_ORDERS_POSITION_KEY = 'vendurepos.till.openOrdersPosition';

export type OpenOrdersPosition = 'top' | 'bottom';

/** v2's Cart settings › Open orders position: bottom (the foot of the cart) unless this till chose top. */
export function loadOpenOrdersPosition(store: KeyValueStore = defaultStore()): OpenOrdersPosition {
  return store.getItem(OPEN_ORDERS_POSITION_KEY) === 'top' ? 'top' : 'bottom';
}

export function saveOpenOrdersPosition(position: OpenOrdersPosition, store: KeyValueStore = defaultStore()): void {
  store.setItem(OPEN_ORDERS_POSITION_KEY, position);
}
