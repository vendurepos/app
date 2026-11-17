import { beforeEach, expect, it } from 'vitest';
import { loadQuickDiscounts, parseQuickDiscounts, saveQuickDiscounts } from './quick-discounts-setting';
import type { KeyValueStore } from './session';

let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
});

it('parses comma- or space-separated whole percents, dropping duplicates in order', () => {
  expect(parseQuickDiscounts('5, 10, 15')).toEqual({ ok: true, values: [5, 10, 15] });
  expect(parseQuickDiscounts('5 10,15')).toEqual({ ok: true, values: [5, 10, 15] });
  expect(parseQuickDiscounts(' 20 ')).toEqual({ ok: true, values: [20] });
  expect(parseQuickDiscounts('10, 5, 10')).toEqual({ ok: true, values: [10, 5] });
});

it('reads empty or blank text as no presets', () => {
  expect(parseQuickDiscounts('')).toEqual({ ok: true, values: [] });
  expect(parseQuickDiscounts('  ')).toEqual({ ok: true, values: [] });
});

it.each(['0', '101', '7.5', '-5', 'abc', '1, 2, 3, 4, 5, 6, 7'])('refuses %j', (text) => {
  expect(parseQuickDiscounts(text)).toEqual({ ok: false });
});

it('loads the v2 defaults when nothing is stored', () => {
  expect(loadQuickDiscounts(store)).toEqual([5, 10, 15]);
});

it('round-trips saved presets, including none', () => {
  saveQuickDiscounts([20, 50], store);
  expect(loadQuickDiscounts(store)).toEqual([20, 50]);
  saveQuickDiscounts([], store);
  expect(loadQuickDiscounts(store)).toEqual([]);
});

it('falls back to the defaults on a garbage stored value', () => {
  store.setItem('vendurepos.till.quickDiscounts', 'x');
  expect(loadQuickDiscounts(store)).toEqual([5, 10, 15]);
});
