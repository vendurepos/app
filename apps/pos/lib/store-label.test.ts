import { expect, it } from 'vitest';
import { storeLabel } from './store-label';

it('the demo build names the demo store', () => {
  expect(storeLabel({ url: 'https://x.example' }, true)).toBe('VendurePOS demo store');
});

it('a normal build shows the store URL', () => {
  expect(storeLabel({ url: 'https://x.example' }, false)).toBe('https://x.example');
});
