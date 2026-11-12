import { expect, it } from 'vitest';
import { initialTenderState, initTenderState, tenderReducer } from '@tallyui/pos';
import { tenderTyped } from './till-tender';

it('does not count the pre-typed balance as cash typed', () => {
  expect(tenderTyped(initTenderState({ methodId: 'cash', balanceMinor: 952 }))).toBe(false);
});

it('counts a keypad digit as cash typed', () => {
  const state = initTenderState({ methodId: 'cash', balanceMinor: 952 });
  expect(tenderTyped(tenderReducer(state, { type: 'key', key: '5' }))).toBe(true);
});

it('does not count a cleared entry as cash typed', () => {
  const state = tenderReducer(initTenderState({ methodId: 'cash', balanceMinor: 952 }), { type: 'key', key: '5' });
  expect(tenderTyped(tenderReducer(state, { type: 'key', key: 'clear' }))).toBe(false);
});

it('does not count the initial state as cash typed', () => {
  expect(tenderTyped(initialTenderState)).toBe(false);
});
