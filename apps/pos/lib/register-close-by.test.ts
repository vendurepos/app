import { beforeEach, expect, it } from 'vitest';
import { closeByKey, loadCloseBy, parseCloseBy, saveCloseBy } from './register-close-by';
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

it('reads a Close by time as HH:mm, empty as none, and refuses anything else', () => {
  for (const [text, time] of [['', undefined], ['  ', undefined], ['21:30', '21:30'], ['9:05', '09:05'], ['00:00', '00:00'], [' 23:59 ', '23:59']] as const) {
    expect(parseCloseBy(text)).toEqual({ ok: true, time });
  }
  for (const text of ['24:00', '21:60', '2130', '21:3', '9pm', '21:30:00']) {
    expect(parseCloseBy(text)).toEqual({ ok: false });
  }
});

it('keeps Close by per register id, and a cleared or bad value reads as none', () => {
  saveCloseBy('reg-a', '21:30', store);
  expect(loadCloseBy('reg-a', store)).toBe('21:30');
  expect(loadCloseBy('reg-b', store)).toBeUndefined();
  expect(store.getItem(closeByKey('reg-a'))).toBe('21:30');
  expect(closeByKey('reg-a')).toBe('vendurepos.register.closeBy.reg-a');
  saveCloseBy('reg-a', undefined, store);
  expect(loadCloseBy('reg-a', store)).toBeUndefined();
  expect(store.getItem(closeByKey('reg-a'))).toBeNull();
  store.setItem(closeByKey('reg-a'), 'soon');
  expect(loadCloseBy('reg-a', store)).toBeUndefined();
});
