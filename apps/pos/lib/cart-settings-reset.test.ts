import { beforeEach, expect, it } from 'vitest';
import { loadAutoPrint, saveAutoPrint } from './auto-print-setting';
import { loadAutoShowReceipt, saveAutoShowReceipt } from './auto-show-receipt-setting';
import { loadCartColumns, saveCartColumns } from './cart-columns-setting';
import { resetCartSettings } from './cart-settings-reset';
import { loadCartSide, saveCartSide } from './cart-side-setting';
import { loadCartSort, saveCartSort } from './cart-sort-setting';
import { loadOpenOrdersPosition, saveOpenOrdersPosition } from './open-orders-position-setting';
import { loadQuickDiscounts, saveQuickDiscounts } from './quick-discounts-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
});

it('restores all seven cart settings to the defaults read from an empty store', () => {
  const data = new Map<string, string>();
  const empty: KeyValueStore = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
  const columns = { image: { show: true } };
  const position = loadOpenOrdersPosition(empty) === 'top' ? 'bottom' : 'top';
  const showReceipt = !loadAutoShowReceipt(empty);
  saveCartSide('left', store);
  saveCartSort('newest', store);
  saveCartColumns(columns, store);
  saveOpenOrdersPosition(position, store);
  saveQuickDiscounts([7], store);
  saveAutoShowReceipt(showReceipt, store);
  saveAutoPrint(true, store);
  expect(loadCartSide(store)).toEqual('left');
  expect(loadCartSort(store)).toEqual('newest');
  expect(loadCartColumns(store)).toEqual(columns);
  expect(loadOpenOrdersPosition(store)).toEqual(position);
  expect(loadQuickDiscounts(store)).toEqual([7]);
  expect(loadAutoShowReceipt(store)).toEqual(showReceipt);
  expect(loadAutoPrint(store)).toEqual(true);

  resetCartSettings(store);

  expect(loadCartSide(store)).toEqual(loadCartSide(empty));
  expect(loadCartSort(store)).toEqual(loadCartSort(empty));
  expect(loadCartColumns(store)).toEqual(loadCartColumns(empty));
  expect(loadOpenOrdersPosition(store)).toEqual(loadOpenOrdersPosition(empty));
  expect(loadQuickDiscounts(store)).toEqual(loadQuickDiscounts(empty));
  expect(loadAutoShowReceipt(store)).toEqual(loadAutoShowReceipt(empty));
  expect(loadAutoPrint(store)).toEqual(loadAutoPrint(empty));
});

it('keeps a setting outside the cart settings', () => {
  store.setItem('vendurepos.till.priceEdit', '0');
  resetCartSettings(store);
  expect(store.getItem('vendurepos.till.priceEdit')).toBe('0');
});
