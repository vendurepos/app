import { expect, it, vi } from 'vitest';
import { initTenderState, tenderReducer } from '@tallyui/pos';
import { evenSplitPlan, fixedSplitPlan, itemsSplitPlan, lineGrossMinor, SPLIT_WAYS } from './tender-split';

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

it("totals a line's gross the way TallyUI does, in the line's own tax mode", () => {
  expect(lineGrossMinor({ netMinor: 800, taxMicros: '152000000', taxInclusive: false })).toBe(952);
  expect(lineGrossMinor({ netMinor: 3499, taxMicros: '664810000', taxInclusive: false })).toBe(4164);
  expect(lineGrossMinor({ netMinor: 952, taxMicros: '152000000', taxInclusive: true })).toBe(952);
});

const mug = { id: 'a', netMinor: 800, taxMicros: '152000000', taxInclusive: false };
const apron = { id: 'b', netMinor: 3499, taxMicros: '664810000', taxInclusive: false };

it('builds an items plan from the picked lines', () => {
  expect(itemsSplitPlan([], [mug, apron], ['a'], 5116)).toEqual({ kind: 'items', lineIds: ['a'], firstMinor: 952, ways: 1, from: 0 });
});

it("keeps the cart's line order, not the pick order", () => {
  expect(itemsSplitPlan([], [mug, apron], ['b', 'a'], 6000)).toMatchObject({ lineIds: ['a', 'b'], firstMinor: 5116 });
});

it('starts an items plan after the captured legs only', () => {
  expect(itemsSplitPlan([{ status: 'captured' }, { status: 'voided' }, {}], [mug, apron], ['a'], 5116)?.from).toBe(2);
});

it('has no items plan without a pick, for an unknown line, or when the pick is the whole balance', () => {
  expect(itemsSplitPlan([], [mug, apron], [], 5116)).toBeNull();
  expect(itemsSplitPlan([], [mug, apron], ['z'], 5116)).toBeNull();
  expect(itemsSplitPlan([], [mug, apron], ['a', 'b'], 5116)).toBeNull();
  expect(itemsSplitPlan([], [mug, apron], ['a'], 952)).toBeNull();
});

it('lets the reducer pre-type the picked items, then the rest', () => {
  const state = tenderReducer(initTenderState({ methodId: 'cash', balanceMinor: 5116 }), { type: 'toggle-split-line', lineId: 'a' });
  expect(state.pickedLineIds).toEqual(['a']);
  const split = tenderReducer(state, { type: 'set-plan', plan: itemsSplitPlan([], [mug, apron], ['a'], 5116)!, balanceMinor: 5116 });
  expect(split.entryMinor).toBe(952);
  expect(split.splitView).toBe(false);
  expect(split.pickedLineIds).toEqual([]);
  const next = tenderReducer(split, {
    type: 'tender-recorded', rowsSinceFrom: [{ title: 'cash', amountMinor: 952 }], balanceMinor: 4164,
  });
  expect(next.entryMinor).toBe(4164);
  expect(next.linesPaidBy).toEqual({ a: ['cash'] });
});
