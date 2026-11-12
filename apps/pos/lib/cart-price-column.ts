// v2's rule for the cart's Price column, copied from TallyUI 3.18 src/cart/cart-columns.tsx (`cartShowsPrice` and its
// three constants), which TallyUI does not export yet. Swap this file for TallyUI's export once it ships one.

/** Under this cart width the Price column folds away (TallyUI src/cart/cart-columns.tsx; use its export when there is one). */
export const PRICE_COLUMN_MIN_WIDTH = 300;
/** A window narrower than this is a phone, with no Price column (TallyUI src/cart/cart-columns.tsx; use its export when there is one). */
export const WIDE_MIN_WIDTH = 768;
/** A window shorter than this is a phone too (TallyUI src/cart/cart-columns.tsx; use its export when there is one). */
export const WIDE_MIN_HEIGHT = 480;

/** Whether the Price column shows. An unmeasured cart (`cartWidth` undefined) counts as wide. */
export function cartShowsPrice({ cartWidth, windowWidth, windowHeight }:
  { cartWidth?: number; windowWidth: number; windowHeight: number }): boolean {
  return (cartWidth ?? Infinity) >= PRICE_COLUMN_MIN_WIDTH && windowWidth >= WIDE_MIN_WIDTH && windowHeight >= WIDE_MIN_HEIGHT;
}
