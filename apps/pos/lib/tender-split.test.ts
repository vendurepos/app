import { createVendureConnector } from '@tallyui/connector-vendure';
import type { StoreSettings } from '@tallyui/core';
import { addEntryToCart, catalogueEntries, createOrderBuilder, initTenderState, TaxProvider, taxProviderProps, tenderReducer, useTax, type TaxContext, type TaxProviderProps } from '@tallyui/pos';
import { createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
  expect(itemsSplitPlan([], [mug, apron], ['b', 'a'], 6000, { hasCharges: true })).toMatchObject({ lineIds: ['a', 'b'], firstMinor: 5116 });
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

// The demo store (lib/cart-totals.test.ts): EUR, prices excluding tax, Standard 19 %, per_rate_group_items / half_up.
const settings: StoreSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190_000, '1': 190_000 },
  taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' }, taxRateCodes: { default: 'Standard DE', '1': 'Standard DE' },
};
const variant = (id: string, sku: string, price: number) =>
  ({ id, name: sku, sku, price, currencyCode: 'EUR', enabled: true, trackInventory: 'FALSE', taxCategory: { id: '1' } });
const products = [
  { id: 'mug', name: 'Tally Fixture Mug', variants: [variant('11', 'TALLY-MUG', 800)] },
  { id: 'apron', name: 'Canvas Apron', variants: [variant('41', 'APRON', 3499)] },
];
const traits = createVendureConnector({ pricesIncludeTax: false }).traits.product;
const entry = (sku: string) => catalogueEntries(products, traits).find((item) => item.variant.sku === sku)!;

/** The context the app's `<TaxProvider {...taxProviderProps(settings)}>` gives the sale. */
function saleTaxContext(): TaxContext {
  let context: TaxContext | undefined;
  const Probe = () => { context = useTax(); return null; };
  renderToString(createElement(TaxProvider, taxProviderProps(settings) as TaxProviderProps, createElement(Probe)));
  return context!;
}

describe('the items plan under an order discount', () => {
  // A €1.00 order discount: shares 19 / 81, line nets 781 / 3418, taxes 148.39 -> 148 and 649.42 -> 649; the order's tax 797.81 -> 798.
  const discounted = (fee = false) => {
    const builder = createOrderBuilder({ currency: settings.currency, taxContext: saleTaxContext() });
    const mugId = addEntryToCart(builder, entry('TALLY-MUG'), traits, 'EUR');
    const apronId = addEntryToCart(builder, entry('APRON'), traits, 'EUR');
    builder.applyOrderDiscount({ type: 'fixed', value: 100 });
    if (fee) builder.addFee({ name: 'Gift wrap', amountMinor: 200 });
    const order = builder.getSnapshot();
    const line = (id: string) => order.lineItems.find((item) => item.id === id)!;
    return { order, mugId, apronId, mug: line(mugId), apron: line(apronId) };
  };

  it("gives each line its share after the order discount, and that share is the plan's first amount", () => {
    const { order, mugId, mug, apron } = discounted();
    expect(lineGrossMinor(mug)).toBeLessThan(952);
    expect([lineGrossMinor(mug), lineGrossMinor(apron), order.balanceDueMinor]).toEqual([929, 4067, 4997]);
    expect(itemsSplitPlan([], order.lineItems, [mugId], order.balanceDueMinor)).toMatchObject({ kind: 'items', firstMinor: lineGrossMinor(mug) });
  });

  it('never asks for the whole balance or more', () => {
    const { order, mugId, apronId } = discounted();
    for (const pick of [[mugId], [apronId], [mugId, apronId]]) {
      const plan = itemsSplitPlan([], order.lineItems, pick, order.balanceDueMinor);
      expect(plan === null || (plan.kind === 'items' && plan.firstMinor < order.balanceDueMinor)).toBe(true);
    }
  });

  it('refuses a pick that leaves no line unpaid when the order has no fees or shipping', () => {
    const { order, mugId, apronId, mug } = discounted();
    expect(itemsSplitPlan([], order.lineItems, [mugId, apronId], order.balanceDueMinor)).toBeNull();
    const rest = order.balanceDueMinor - lineGrossMinor(mug);
    expect(itemsSplitPlan([{ status: 'captured' }], order.lineItems, [apronId], rest)).not.toBeNull();
    expect(itemsSplitPlan([{ status: 'captured' }], order.lineItems, [apronId], rest, { paidLineIds: [mugId] })).toBeNull();
  });

  it('lets every line go first when the order has a charge to pay after', () => {
    const { order, mugId, apronId, mug, apron } = discounted(true);
    expect(itemsSplitPlan([], order.lineItems, [mugId, apronId], order.balanceDueMinor, { hasCharges: true }))
      .toMatchObject({ kind: 'items', firstMinor: lineGrossMinor(mug) + lineGrossMinor(apron) });
  });
});
