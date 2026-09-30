import { createVendureConnector } from '@tallyui/connector-vendure';
import type { StoreSettings } from '@tallyui/core';
import {
  addEntryToCart, catalogueEntries, createOrderBuilder, TaxProvider, taxFiguresForBasket, taxProviderProps, useTax, type TaxContext, type TaxProviderProps,
} from '@tallyui/pos';
import { createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cartTabLabel, cartTotals } from './cart-totals';

// The dev store (dev/vendure-store/src/seed.ts): Germany, Standard 19 % (category 1, the default) and Reduced 7 %
// (category 2), prices excluding tax, and /info's per_rate_group_items / half_up (vendurepos #60).
const ROUNDING = { granularity: 'per_rate_group_items', mode: 'half_up' } as const;
// The rate names as vendureStoreSettings gives them (TallyUI #334; lib/store-settings.test.ts checks its keys).
const settings: StoreSettings = {
  currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190_000, '1': 190_000, '2': 70_000 }, taxRounding: ROUNDING,
  taxRateCodes: { default: 'Standard DE', '1': 'Standard DE', '2': 'Reduced DE' },
};

const variant = (id: string, sku: string, price: number, category: string, name = sku) =>
  ({ id, name, sku, price, currencyCode: 'EUR', enabled: true, trackInventory: 'FALSE', taxCategory: { id: category } });
const products = [
  { id: 'mug', name: 'Tally Fixture Mug', variants: [variant('11', 'TALLY-MUG', 800, '1')] },
  { id: 'beans', name: 'Espresso Beans', variants: [variant('21', 'ESP-250', 899, '2', '250 g'), variant('22', 'ESP-1000', 2999, '2', '1 kg')] },
  { id: 'cards', name: 'Postcard Set', variants: [variant('31', 'POST-SET', 599, '1')] },
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

const standard = { code: 'Standard DE', ratePpm: 190_000 };
const reduced = { code: 'Reduced DE', ratePpm: 70_000 };
const basketLine = (unitPriceMinor: number, quantity: number, tax: typeof standard) =>
  ({ unitPriceMinor, quantity, taxInclusive: false, taxLines: [tax] });

describe('the cart under the store tax settings', () => {
  it('adds lines, changes a quantity and removes a line, with the figures taxFiguresForBasket gives', () => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: saleTaxContext() });
    const mug = addEntryToCart(builder, entry('TALLY-MUG'), traits, 'EUR');
    const beans = addEntryToCart(builder, entry('ESP-250'), traits, 'EUR');
    builder.updateQuantity(beans, 3);
    let order = builder.getSnapshot();
    expect(order.lineItems.map((line) => [line.name, line.quantity])).toEqual([['Tally Fixture Mug', 1], ['Espresso Beans · 250 g', 3]]);
    let expected = taxFiguresForBasket('EUR', false, [basketLine(800, 1, standard), basketLine(899, 3, reduced)], ROUNDING);
    // 152 + 188.79 -> 189: per_order would give 340.79 -> 341 too.
    expect(cartTotals(order)).toEqual({
      subtotalMinor: 3497, taxMinor: 341, totalMinor: 3838, taxLabel: 'Tax',
      taxRows: [
        { label: 'Standard DE 19%', name: 'Standard DE 19%', amountMinor: 152 }, { label: 'Reduced DE 7%', name: 'Reduced DE 7%', amountMinor: 189 },
      ],
    });
    expect([expected.subtotalMinor, expected.taxMinor, expected.totalMinor]).toEqual([3497, 341, 3838]);

    // Two postcard sets: Standard 1998 x 19 % = 379.62 -> 380 and Reduced 189, so 569; per_order: 568.41 -> 568.
    addEntryToCart(builder, entry('POST-SET'), traits, 'EUR');
    addEntryToCart(builder, entry('POST-SET'), traits, 'EUR');
    order = builder.getSnapshot();
    expected = taxFiguresForBasket('EUR', false,
      [basketLine(800, 1, standard), basketLine(899, 3, reduced), basketLine(599, 2, standard)], ROUNDING);
    expect(cartTotals(order)).toMatchObject({ subtotalMinor: expected.subtotalMinor, taxMinor: expected.taxMinor, totalMinor: expected.totalMinor });
    expect([expected.subtotalMinor, expected.taxMinor, expected.totalMinor]).toEqual([4695, 569, 5264]);
    expect(taxFiguresForBasket('EUR', false,
      [basketLine(800, 1, standard), basketLine(899, 3, reduced), basketLine(599, 2, standard)]).taxMinor).toBe(568);
    expect(cartTotals(order).taxRows).toEqual(expected.taxByRate.map(({ code, ratePpm, amountMinor }) =>
      ({ label: `${code} ${ratePpm / 10_000}%`, name: `${code} ${ratePpm / 10_000}%`, amountMinor })));

    // The cart's − at quantity 1 sets 0, which takes the line off.
    builder.updateQuantity(mug, 0);
    order = builder.getSnapshot();
    expected = taxFiguresForBasket('EUR', false, [basketLine(899, 3, reduced), basketLine(599, 2, standard)], ROUNDING);
    expect(order.lineItems.map((line) => line.name)).toEqual(['Espresso Beans · 250 g', 'Postcard Set']);
    // Standard 1198 x 19 % = 227.62 -> 228, Reduced 189: 417; per_order 416.41 -> 416.
    expect([expected.subtotalMinor, expected.taxMinor, expected.totalMinor]).toEqual([3895, 417, 4312]);
    expect(cartTotals(order)).toEqual({
      subtotalMinor: 3895, taxMinor: 417, totalMinor: 4312, taxLabel: 'Tax',
      taxRows: [
        { label: 'Reduced DE 7%', name: 'Reduced DE 7%', amountMinor: 189 }, { label: 'Standard DE 19%', name: 'Standard DE 19%', amountMinor: 228 },
      ],
    });
  });

  it("gives each line's tax the store's rate name, which per_rate_group_items groups by", () => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: saleTaxContext() });
    addEntryToCart(builder, entry('TALLY-MUG'), traits, 'EUR');
    addEntryToCart(builder, entry('ESP-250'), traits, 'EUR');
    expect(builder.getSnapshot().lineItems.map((line) => line.taxLines.map((tax) => tax.code))).toEqual([['Standard DE'], ['Reduced DE']]);
  });

  it("labels the narrow layout's Cart tab with the item count, the sum of quantities, and the total", () => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: saleTaxContext() });
    const format = ({ amount, currency }: { amount: number; currency: string }) => `${currency} ${amount}`;
    expect(cartTabLabel(builder.getSnapshot(), format)).toBe('Cart (0) · EUR 0');
    addEntryToCart(builder, entry('TALLY-MUG'), traits, 'EUR');
    builder.updateQuantity(addEntryToCart(builder, entry('ESP-250'), traits, 'EUR'), 3);
    // Four items: 800 + 3 x 899 = 3497, plus 341 tax (above) = 3838.
    expect(cartTabLabel(builder.getSnapshot(), format)).toBe('Cart (4) · EUR 3838');
  });
});
