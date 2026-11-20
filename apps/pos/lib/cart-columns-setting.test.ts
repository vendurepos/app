import { beforeEach, expect, it } from 'vitest';
import { cartColumnShown, loadCartColumns, saveCartColumns } from './cart-columns-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
});

it('uses TallyUI defaults when nothing is stored', () => {
  expect(loadCartColumns(store)).toEqual({});
  expect(cartColumnShown({})).toEqual({
    quantity: true, quantitySplit: false, image: false, name: true,
    nameSku: false, sku: false, price: true, total: true,
  });
});

it('round-trips every known boolean field', () => {
  const columns = {
    quantity: { show: false, split: true }, image: { show: true }, name: { show: true, sku: false },
    sku: { show: false }, price: { show: false }, total: { show: true },
  };
  saveCartColumns(columns, store);
  expect(loadCartColumns(store)).toEqual(columns);
});

it.each(['{', '[1]', '7', 'null', 'true', '"columns"'])('ignores invalid or non-object JSON: %s', (stored) => {
  store.setItem('vendurepos.till.cartColumns', stored);
  expect(loadCartColumns(store)).toEqual({});
});

it('drops non-boolean fields and ignores unknown keys', () => {
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ image: { show: 'yes' }, sku: { show: true }, extra: 1 }));
  expect(loadCartColumns(store)).toEqual({ sku: { show: true } });
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({
    quantity: { show: false, split: 'yes', extra: true }, image: { show: 1 }, name: { show: null, sku: 0 },
    sku: { show: true, split: true }, price: { show: {} }, total: { show: [] }, extra: { show: true },
  }));
  expect(loadCartColumns(store)).toEqual({ quantity: { show: false }, sku: { show: true } });
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ quantity: [], image: true, name: null, sku: 'yes' }));
  expect(loadCartColumns(store)).toEqual({});
});

it('uses explicit false and true switches over the defaults', () => {
  expect(cartColumnShown({
    quantity: { show: false, split: true }, image: { show: true }, name: { show: false, sku: true },
    sku: { show: true }, price: { show: false }, total: { show: false },
  })).toEqual({
    quantity: false, quantitySplit: true, image: true, name: false,
    nameSku: true, sku: true, price: false, total: false,
  });
});
