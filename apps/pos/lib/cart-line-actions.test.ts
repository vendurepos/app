import { expect, it } from 'vitest';
import { lineActionIds, QUICK_DISCOUNTS } from './cart-line-actions';

it('keeps Discount and Remove in the quantity keypad when the price column is shown', () => {
  expect(lineActionIds({ canEditPrice: true, priceShown: true })).toEqual(['discount', 'remove']);
});

it('adds Price between Discount and Remove when editable prices are folded', () => {
  expect(lineActionIds({ canEditPrice: true, priceShown: false })).toEqual(['discount', 'price', 'remove']);
});

it('omits Price when the till does not allow price edits', () => {
  expect(lineActionIds({ canEditPrice: false, priceShown: false })).toEqual(['discount', 'remove']);
});

it('uses the v2 quick-discount presets', () => {
  expect(QUICK_DISCOUNTS).toEqual([5, 10, 15]);
});
