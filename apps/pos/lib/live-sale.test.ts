// @vitest-environment happy-dom
import type { CashRounding, Payment } from '@tallyui/pos';
import { act, createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { liveSaleView, usePublishLiveSale, type LiveSale, type LiveSaleRef } from './live-sale';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type View = ReturnType<LiveSale['registerView']>;
const leg = { id: 'leg-1', method: 'cash', amountMinor: 500 } as unknown as Payment;
const rounding = { legId: 'leg-1', amountMinor: -2 } as unknown as CashRounding;
const saleOf = (view: View): LiveSale => ({ registerView: () => view });
const empty: View = { takenLegs: [], saving: false, cashRoundings: [] };

function Published({ live, sale }: { live: LiveSaleRef; sale: LiveSale }) {
  usePublishLiveSale(live, sale);
  return null;
}

let root: { render(node: unknown): void; unmount(): void };
let live: LiveSaleRef;
beforeEach(() => {
  root = createRoot(document.createElement('div'));
  live = { current: null };
});
afterEach(() => act(() => root.unmount()));

it('counts nothing while no sale is mounted', () => {
  expect(liveSaleView(live)).toEqual(empty);
});

it('passes the mounted sale’s view through whole, its saving flag and cash roundings included', () => {
  const view: View = { takenLegs: [leg], saving: true, cashRoundings: [rounding] };
  act(() => root.render(createElement(Published, { live, sale: saleOf(view) })));
  expect(liveSaleView(live)).toBe(view);
});

it('reads the view when the register asks, not when the sale was published', () => {
  let view: View = empty;
  act(() => root.render(createElement(Published, { live, sale: { registerView: () => view } })));
  view = { takenLegs: [leg], saving: false, cashRoundings: [] };
  expect(liveSaleView(live).takenLegs).toEqual([leg]);
});

it('withdraws the sale when it unmounts', () => {
  act(() => root.render(createElement(Published, { live, sale: saleOf({ ...empty, takenLegs: [leg] }) })));
  act(() => root.render(null));
  expect(live.current).toBeNull();
  expect(liveSaleView(live)).toEqual(empty);
});

it('follows the sale across renders, and a remount publishes the new sale', () => {
  const first = saleOf({ ...empty, takenLegs: [leg] });
  const second = saleOf({ ...empty, saving: true });
  act(() => root.render(createElement(Published, { key: 'a', live, sale: first })));
  expect(live.current).toBe(first);
  act(() => root.render(createElement(Published, { key: 'b', live, sale: second })));
  expect(live.current).toBe(second);
  expect(liveSaleView(live).saving).toBe(true);
});

it('an old sale’s cleanup leaves a newer sale published', () => {
  const first = saleOf(empty);
  const second = saleOf({ ...empty, takenLegs: [leg] });
  const other = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Published, { live, sale: first })));
  act(() => other.render(createElement(Published, { live, sale: second })));
  act(() => root.unmount());
  expect(live.current).toBe(second);
  act(() => other.unmount());
  expect(live.current).toBeNull();
  root = createRoot(document.createElement('div'));
});
