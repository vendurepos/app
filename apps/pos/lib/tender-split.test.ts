import { expect, it, vi } from 'vitest';
import { initTenderState, tenderReducer } from '@tallyui/pos';
import { evenSplitPlan, fixedSplitPlan, SPLIT_WAYS } from './tender-split';

vi.mock('@tallyui/components', () => ({}));

it('offers even splits from two to six ways', () => {
  expect(SPLIT_WAYS).toEqual([2, 3, 4, 5, 6]);
});

it('starts an even split at zero when there are no payments', () => {
  expect(evenSplitPlan([], 2)).toEqual({ kind: 'even', ways: 2, from: 0 });
});

it('counts only captured payments, including legs without a status', () => {
  expect(evenSplitPlan([{ status: 'captured' }, { status: 'voided' }, { status: 'pending' }, {}], 3).from).toBe(2);
});

it('lets the reducer pre-type the first share and close the split picker', () => {
  const state = tenderReducer(initTenderState({ methodId: 'cash', balanceMinor: 952 }), { type: 'open-split' });
  const split = tenderReducer(state, { type: 'set-plan', plan: evenSplitPlan([], 2), balanceMinor: 952 });
  expect(split.entryMinor).toBe(476);
  expect(split.splitView).toBe(false);
});

it('lets the reducer round each share after a payment', () => {
  const state = initTenderState({ methodId: 'cash', balanceMinor: 1001 });
  const split = tenderReducer(state, { type: 'set-plan', plan: evenSplitPlan([], 3), balanceMinor: 1001 });
  expect(split.entryMinor).toBe(334);
  const next = tenderReducer(split, {
    type: 'tender-recorded', rowsSinceFrom: [{ title: 'cash', amountMinor: 334 }], balanceMinor: 667,
  });
  expect(next.entryMinor).toBe(334);
});

it('clears the plan and pre-types the balance', () => {
  const state = initTenderState({ methodId: 'cash', balanceMinor: 952 });
  const split = tenderReducer(state, { type: 'set-plan', plan: evenSplitPlan([], 2), balanceMinor: 952 });
  const cleared = tenderReducer(split, { type: 'clear-plan', balanceMinor: 952 });
  expect(cleared.plan).toBeNull();
  expect(cleared.entryMinor).toBe(952);
});

it('builds a fixed plan from the typed amount', () => {
  expect(fixedSplitPlan([], '5.00', 'EUR', 952)).toEqual({ kind: 'fixed', firstMinor: 500, title: null, from: 0 });
  expect(fixedSplitPlan([], ' 5 ', 'EUR', 952)).toMatchObject({ firstMinor: 500 });
  expect(fixedSplitPlan([], '0.5', 'EUR', 952)).toMatchObject({ firstMinor: 50 });
});

it('starts a fixed plan after the captured legs only', () => {
  expect(fixedSplitPlan([{ status: 'captured' }, { status: 'voided' }, {}], '1', 'EUR', 952)?.from).toBe(2);
});

it.each(['', 'abc', '-1', '0', '0.00', '5.001', '9.52', '10'])('has no fixed plan for %j at a balance of 952', (text) => {
  expect(fixedSplitPlan([], text, 'EUR', 952)).toBeNull();
});

it("follows the currency's exponent", () => {
  expect(fixedSplitPlan([], '500', 'JPY', 952)).toMatchObject({ firstMinor: 500 });
  expect(fixedSplitPlan([], '5.5', 'JPY', 952)).toBeNull();
});

it('lets the reducer pre-type the fixed amount, then the rest', () => {
  const state = initTenderState({ methodId: 'cash', balanceMinor: 952 });
  const split = tenderReducer(state, { type: 'set-plan', plan: fixedSplitPlan([], '5.00', 'EUR', 952)!, balanceMinor: 952 });
  expect(split.entryMinor).toBe(500);
  expect(split.splitView).toBe(false);
  const next = tenderReducer(split, {
    type: 'tender-recorded', rowsSinceFrom: [{ title: 'cash', amountMinor: 500 }], balanceMinor: 452,
  });
  expect(next.entryMinor).toBe(452);
});
