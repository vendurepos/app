import { expect, it } from 'vitest';
import { cartShowsPrice } from './cart-price-column';

it('counts an unmeasured cart on a wide window as wide', () => {
  expect(cartShowsPrice({ cartWidth: undefined, windowWidth: 1280, windowHeight: 800 })).toBe(true);
});

it('folds the Price column on a cart narrower than 300', () => {
  expect(cartShowsPrice({ cartWidth: 299, windowWidth: 1280, windowHeight: 800 })).toBe(false);
});

it('folds it on a window narrower than 768', () => {
  expect(cartShowsPrice({ cartWidth: 384, windowWidth: 767, windowHeight: 800 })).toBe(false);
});

it('folds it on a window shorter than 480', () => {
  expect(cartShowsPrice({ cartWidth: 384, windowWidth: 1280, windowHeight: 479 })).toBe(false);
});

it('shows it at exactly 300 wide on a 768 × 480 window', () => {
  expect(cartShowsPrice({ cartWidth: 300, windowWidth: 768, windowHeight: 480 })).toBe(true);
});
