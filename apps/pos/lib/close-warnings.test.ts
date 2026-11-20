import { expect, it } from 'vitest';
import { closeWarningLines } from './close-warnings';

it('has no warnings when nothing is left', () => {
  expect(closeWarningLines(0, 0)).toEqual([]);
});

it('warns about one parked sale', () => {
  expect(closeWarningLines(1, 0)).toEqual([{ code: 'parkedSales', text: '1 parked sale' }]);
});

it('warns about several parked sales', () => {
  expect(closeWarningLines(3, 0)).toEqual([{ code: 'parkedSales', text: '3 parked sales' }]);
});

it('warns about a partly paid sale', () => {
  expect(closeWarningLines(0, 500)).toEqual([{ code: 'partlyPaidSale', text: 'A sale is partly paid' }]);
});

it('lists parked sales before a partly paid sale', () => {
  expect(closeWarningLines(2, 500)).toEqual([
    { code: 'parkedSales', text: '2 parked sales' },
    { code: 'partlyPaidSale', text: 'A sale is partly paid' },
  ]);
});
