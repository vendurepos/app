// @vitest-environment happy-dom
// 3.2a-3b (2026-11-22): what the cashier sees when useTenderMethods hands useTender a new list mid-tender. It pins
// @tallyui/components 5.0.0 dist/index.js: useTender (:10961) re-inits only on a stage.kind change (:10966-10968), so
// state.methodId outlives the list; TenderPane's method lookup (:11154), take() (:11204-11205, returns with no
// method), the tiles' aria-selected (:11293) and the Take button, rendered only with a method (:11368).
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createVendureConnector } from '@tallyui/connector-vendure';
import type { PaymentMethodDescriptor, StoreSettings } from '@tallyui/core';
import { act, createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DEMO_INFO } from './demo/store';
import { parseTenderMethods } from './tender-methods';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @tallyui/components loads outside vite, so vi.mock cannot reach its imports: Node's own resolve hook gives it
// react-native-web (as the web build does) and an empty react-native-svg (the tiles' icons only).
const web = pathToFileURL(createRequire(import.meta.url).resolve('react-native-web')).href;
const svg = 'data:text/javascript,const n=()=>null;export default n;export const Circle=n,Line=n,Path=n,Polyline=n,Rect=n;';
const hooks = registerHooks({
  resolve: (specifier, context, next) => specifier === 'react-native' ? { url: web, shortCircuit: true }
    : specifier === 'react-native-svg' ? { url: svg, shortCircuit: true } : next(specifier, context),
});
afterAll(() => hooks.deregister());

type Pos = typeof import('@tallyui/pos');
type Components = typeof import('@tallyui/components');
let pos: Pos, ui: Components;
beforeAll(async () => {
  pos = await import('@tallyui/pos');
  ui = await import('@tallyui/components');
});

const settings: StoreSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190_000, '1': 190_000 } };
const products = [{ id: 'mug', name: 'Mug', variants: [{ id: '11', name: 'Mug', sku: 'MUG', price: 800, currencyCode: 'EUR', enabled: true, trackInventory: 'FALSE', taxCategory: { id: '1' } }] }];
const listed = parseTenderMethods(DEMO_INFO, 10)!;
const [cash, card] = listed;

let sale: ReturnType<Pos['useSale']>;
function Till({ methods }: { methods: PaymentMethodDescriptor[] }) {
  sale = pos.useSale(settings, { registerId: 'register-1', cashierRef: 'cashier', capabilities: { orderCreate: 10, register: 3 } });
  const { state, dispatch } = ui.useTender(sale, methods);
  return createElement(ui.TenderPane, { sale, state, dispatch, methods });
}

let host: HTMLElement;
let root: { render(node: unknown): void; unmount(): void };
const render = (methods: PaymentMethodDescriptor[]) =>
  act(async () => root.render(createElement(pos.TaxProvider, pos.taxProviderProps(settings) as Parameters<Pos['TaxProvider']>[0], createElement(Till, { methods }))));
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (...ids: string[]) => {
  for (const id of ids) {
    expect(byId(id), id).not.toBeNull();
    await act(async () => byId(id)!.click());
  }
};
const typeKeys = (digits: string) => press(...[...digits].map((digit) => `tender-keypad-key-${digit}`));
const selected = () => listed.filter(({ id }) => byId(`tender-method-${id}`)?.getAttribute('aria-selected') === 'true').map(({ id }) => id);
const tiles = () => listed.map(({ id }) => id).filter((id) => byId(`tender-method-${id}`));
const entry = () => byId('tender-entry-amount')?.textContent;
const legs = () => sale.order.payments.map(({ method, methodId, amountMinor }) => ({ method, methodId, amountMinor }));
const cashLeg = { method: 'cash', methodId: undefined, amountMinor: 500 };

beforeEach(async () => {
  host = document.createElement('div');
  act(() => root?.unmount());
  root = createRoot(host);
  await render(listed);
  const traits = createVendureConnector({ pricesIncludeTax: false }).traits.product;
  // 1. Open the tender (the app's Pay button, which is outside TenderPane, calls startTender too).
  await act(async () => { sale.add(pos.catalogueEntries(products, traits)[0], traits); });
  await act(async () => { sale.startTender('cash'); });
  expect(sale.order.balanceDueMinor).toBe(952);
  expect(selected()).toEqual(['cash']);
  // 2. A cash leg of 5.00 of the 9.52.
  await typeKeys('500');
  await press('tender-take');
  expect(legs()).toEqual([cashLeg]);
  // 3. The voucher tile, and 2.00 typed but not taken.
  await press('tender-method-voucher');
  await press('tender-keypad-key-clear');
  await typeKeys('200');
  expect(selected()).toEqual(['voucher']);
  expect(entry()).toBe('€2.00');
  expect(sale.order.balanceDueMinor).toBe(452);
});

it('(a) the same three methods in a new array keep the leg, the voucher selection, the typed 2.00 and the balance', async () => {
  await render(listed.map((method) => ({ ...method })));
  expect(legs()).toEqual([cashLeg]);
  expect(selected()).toEqual(['voucher']);
  expect(entry()).toBe('€2.00');
  expect(byId('tender-take')?.textContent).toContain(listed[2].title);
  expect(sale.order.balanceDueMinor).toBe(452);
});

it('(b) with the voucher gone no tile is selected, Take adds nothing, and Cash then takes the rest', async () => {
  await render([cash, card]);
  expect(legs()).toEqual([cashLeg]);
  expect(sale.order.balanceDueMinor).toBe(452);
  expect(tiles()).toEqual(['cash', 'card-terminal']);
  expect(selected()).toEqual([]);
  expect(entry()).toBe('€2.00');
  expect(byId('tender-entry-hint')?.textContent).toBe('Part payment · €2.52 left after this');
  // With no method TenderPane renders no Take at all (:11111), so the cashier has nothing to press; nothing is added.
  expect(byId('tender-take')).toBeNull();
  expect(legs()).toEqual([cashLeg]);
  await press('tender-method-cash', 'tender-keypad-key-clear');
  await typeKeys('452');
  await press('tender-take');
  expect(legs()).toEqual([cashLeg, { ...cashLeg, amountMinor: 452 }]);
  expect(sale.order.balanceDueMinor).toBe(0);
});
