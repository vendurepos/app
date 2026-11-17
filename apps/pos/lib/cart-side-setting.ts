import { defaultStore, type KeyValueStore } from './session';

const CART_SIDE_KEY = 'vendurepos.till.cartSide';

export type CartSide = 'left' | 'right';

/** v2's Cart settings › Panel position: right unless this till chose left. */
export function loadCartSide(store: KeyValueStore = defaultStore()): CartSide {
  return store.getItem(CART_SIDE_KEY) === 'left' ? 'left' : 'right';
}

export function saveCartSide(side: CartSide, store: KeyValueStore = defaultStore()): void {
  store.setItem(CART_SIDE_KEY, side);
}
