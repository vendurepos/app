import type { StoreSettings } from '@tallyui/core';
import { expect, it } from 'vitest';
import { percentOfPpm, taxRateRows } from './tax-settings';

it('shows a ppm rate as a percent without trailing zeros', () => {
  expect([190000, 70000, 55000, 0].map(percentOfPpm)).toEqual(['19 %', '7 %', '5.5 %', '0 %']);
});

it("lists the demo zone's rates by category, highest first, leaving out default", () => {
  const settings = {
    currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000, '1': 190000, '2': 70000 },
    taxRateCodes: { default: 'Standard DE', '1': 'Standard DE', '2': 'Reduced DE' },
  } as StoreSettings;
  expect(taxRateRows(settings)).toEqual([
    { key: '1', name: 'Standard DE', rate: '19 %' },
    { key: '2', name: 'Reduced DE', rate: '7 %' },
  ]);
});

it('names a category with no rate name by its id', () => {
  const settings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 0, '3': 0 } } as StoreSettings;
  expect(taxRateRows(settings)).toEqual([{ key: '3', name: 'Tax category 3', rate: '0 %' }]);
});
