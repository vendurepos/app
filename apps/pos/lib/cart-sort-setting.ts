import { defaultStore, type KeyValueStore } from './session';

const CART_SORT_KEY = 'vendurepos.till.cartSort';

export type CartSort = 'newest' | 'oldest';

/** v2's Cart settings › Sort items: oldest at top (the order lines were added) unless this till chose newest. */
export function loadCartSort(store: KeyValueStore = defaultStore()): CartSort {
  return store.getItem(CART_SORT_KEY) === 'newest' ? 'newest' : 'oldest';
}

export function saveCartSort(sort: CartSort, store: KeyValueStore = defaultStore()): void {
  store.setItem(CART_SORT_KEY, sort);
}

/** The cart's item lines in the chosen order; a new array, the order's own lines untouched. Fees and shipping are not lines, so they stay last. */
export function sortCartLines<T>(lines: readonly T[], sort: CartSort): T[] {
  return sort === 'newest' ? [...lines].reverse() : [...lines];
}
