import { beforeEach, expect, it } from 'vitest';
import { CART_COLUMN_ORDER, cartColumnShown, loadCartColumns, moveCartColumn, saveCartColumns } from './cart-columns-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
});

const order = [...CART_COLUMN_ORDER];

it('uses TallyUI defaults when nothing is stored', () => {
  expect(loadCartColumns(store)).toEqual({ order });
  expect(order).toEqual(['quantity', 'image', 'name', 'sku', 'price', 'total']);
  expect(cartColumnShown({})).toEqual({
    quantity: true, quantitySplit: false, image: false, name: true,
    nameSku: false, sku: false, price: true, total: true,
  });
});

it('round-trips every known boolean field and the order', () => {
  const columns = {
    quantity: { show: false, split: true }, image: { show: true }, name: { show: true, sku: false },
    sku: { show: false }, price: { show: false }, total: { show: true },
    order: ['total', 'price', 'sku', 'name', 'image', 'quantity'] as const,
  };
  saveCartColumns(columns, store);
  expect(loadCartColumns(store)).toEqual(columns);
});

it.each(['{', '[1]', '7', 'null', 'true', '"columns"'])('ignores invalid or non-object JSON: %s', (stored) => {
  store.setItem('vendurepos.till.cartColumns', stored);
  expect(loadCartColumns(store)).toEqual({ order });
});

it('drops non-boolean fields and ignores unknown keys', () => {
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ image: { show: 'yes' }, sku: { show: true }, extra: 1 }));
  expect(loadCartColumns(store)).toEqual({ sku: { show: true }, order });
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({
    quantity: { show: false, split: 'yes', extra: true }, image: { show: 1 }, name: { show: null, sku: 0 },
    sku: { show: true, split: true }, price: { show: {} }, total: { show: [] }, extra: { show: true },
  }));
  expect(loadCartColumns(store)).toEqual({ quantity: { show: false }, sku: { show: true }, order });
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ quantity: [], image: true, name: null, sku: 'yes' }));
  expect(loadCartColumns(store)).toEqual({ order });
});

it('fills the default order into a value saved before 9.10b, which has no order', () => {
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ image: { show: true }, price: { show: false } }));
  expect(loadCartColumns(store)).toEqual({ image: { show: true }, price: { show: false }, order });
});

it('keeps a partial order first, drops unknown and repeated ids, and appends the missing ones in the default order', () => {
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ order: ['total', 'regularPrice', 'bogus', 7, 'total', 'image'] }));
  expect(loadCartColumns(store)).toEqual({ order: ['total', 'image', 'quantity', 'name', 'sku', 'price'] });
  store.setItem('vendurepos.till.cartColumns', JSON.stringify({ order: 'total' }));
  expect(loadCartColumns(store)).toEqual({ order });
});

it('moves a column one place up or down, and leaves the columns alone at either end', () => {
  const columns = { image: { show: true }, order };
  expect(moveCartColumn(columns, 'name', -1)).toEqual({ image: { show: true }, order: ['quantity', 'name', 'image', 'sku', 'price', 'total'] });
  expect(moveCartColumn(columns, 'name', 1)).toEqual({ image: { show: true }, order: ['quantity', 'image', 'sku', 'name', 'price', 'total'] });
  expect(moveCartColumn(columns, 'quantity', -1)).toBe(columns);
  expect(moveCartColumn(columns, 'total', 1)).toBe(columns);
  expect(moveCartColumn({}, 'quantity', 1)).toEqual({ order: ['image', 'quantity', 'name', 'sku', 'price', 'total'] });
  expect(columns.order).toEqual(CART_COLUMN_ORDER);
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
