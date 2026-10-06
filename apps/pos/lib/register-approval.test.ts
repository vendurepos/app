import { closeNeedsApproval } from '@tallyui/pos';
import { beforeEach, expect, it } from 'vitest';
import { loadVarianceLimitMinor, parseVarianceLimit, saveVarianceLimitMinor, typedApprover, VARIANCE_LIMIT_KEY } from './register-approval';
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

it('no limit stored: undefined, so no approval is asked', () => {
  expect(loadVarianceLimitMinor(store)).toBeUndefined();
  expect(closeNeedsApproval(9000, 10000, loadVarianceLimitMinor(store))).toBe(false);
});

it('parses amounts to minor units and refuses the rest', () => {
  for (const [text, minor] of [['5', 500], ['5.5', 550], ['5.50', 550], ['0', 0], ['', undefined], ['100000', 10000000], ['1.01', 101]] as const) {
    expect(parseVarianceLimit(text)).toEqual({ ok: true, minor });
  }
  for (const text of ['5.555', '-1', 'abc', '100000.01', ' ', ' 5', '5\n', '5.', '.5', '1e2']) {
    expect(parseVarianceLimit(text)).toEqual({ ok: false });
  }
});

it('save and load round-trip, and saving undefined clears it', () => {
  saveVarianceLimitMinor(550, store);
  expect(loadVarianceLimitMinor(store)).toBe(550);
  expect(closeNeedsApproval(9449, 10000, loadVarianceLimitMinor(store))).toBe(true);
  expect(closeNeedsApproval(9450, 10000, loadVarianceLimitMinor(store))).toBe(false);
  saveVarianceLimitMinor(0, store);
  expect(loadVarianceLimitMinor(store)).toBe(0);
  saveVarianceLimitMinor(undefined, store);
  expect(store.getItem(VARIANCE_LIMIT_KEY)).toBeNull();
  expect(loadVarianceLimitMinor(store)).toBeUndefined();
});

it('invalid stored values mean no limit', () => {
  for (const value of ['', ' ', '-1', '1.5', 'abc', 'Infinity', '9007199254740992']) {
    store.setItem(VARIANCE_LIMIT_KEY, value);
    expect(loadVarianceLimitMinor(store)).toBeUndefined();
  }
});

it('a typed approver is recorded as typed, never bare', () => {
  expect(typedApprover('  Sam ')).toEqual({ approvedBy: 'typed:Sam', approvedByName: 'Sam (typed)' });
  expect(typedApprover('  ')).toBeNull();
});
