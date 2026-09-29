import { expect, it } from 'vitest';
import { roundHalfAwayFromZero } from '../src/plugin/rounding';

it.each([
  [19n, 2n, 10n], [-19n, 2n, -10n], [18n, 2n, 9n], [-18n, 2n, -9n],
  [1n, 3n, 0n], [-1n, 3n, 0n], [2n, 3n, 1n], [-2n, 3n, -1n], [0n, 2n, 0n],
])('roundHalfAwayFromZero(%s, %s) = %s', (numerator, denominator, expected) => {
  expect(roundHalfAwayFromZero(numerator, denominator)).toBe(expected);
});
