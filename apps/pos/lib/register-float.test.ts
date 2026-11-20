import { beforeEach, expect, it } from 'vitest';
import { floatKey, formatOpeningFloat, loadOpeningFloatMinor, parseOpeningFloat, saveOpeningFloatMinor } from './register-float';
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

it("reads an opening float in the currency's minor units, empty as none, and refuses anything else", () => {
  for (const [text, minor] of [['', undefined], ['  ', undefined], ['150', 15000], ['150.5', 15050], [' 0.00 ', 0], ['1000000.00', 100000000]] as const) {
    expect(parseOpeningFloat(text, 2)).toEqual({ ok: true, minor });
  }
  for (const text of ['-5', '1.234', 'abc', '1,50', '1000000.01']) {
    expect(parseOpeningFloat(text, 2)).toEqual({ ok: false });
  }
  expect(parseOpeningFloat('500', 0)).toEqual({ ok: true, minor: 500 });
  expect(formatOpeningFloat(15050, 2)).toBe('150.50');
  expect(formatOpeningFloat(500, 0)).toBe('500');
  expect(formatOpeningFloat(undefined, 2)).toBe('');
});

it('keeps the opening float per register id, and a cleared or bad value reads as none', () => {
  saveOpeningFloatMinor('reg-a', 15000, store);
  expect(loadOpeningFloatMinor('reg-a', store)).toBe(15000);
  expect(loadOpeningFloatMinor('reg-b', store)).toBeUndefined();
  expect(floatKey('reg-a')).toBe('vendurepos.register.floatMinor.reg-a');
  saveOpeningFloatMinor('reg-a', undefined, store);
  expect(loadOpeningFloatMinor('reg-a', store)).toBeUndefined();
  expect(store.getItem(floatKey('reg-a'))).toBeNull();
  for (const value of ['1.5', '-1', 'abc', '100000001']) {
    store.setItem(floatKey('reg-a'), value);
    expect(loadOpeningFloatMinor('reg-a', store)).toBeUndefined();
  }
});
