import { describe, expect, it } from 'vitest';
import { createVendureConnector, vendureProductTraits } from '@tallyui/connector-vendure';
import { productRows } from './product-rows';

const variant = (id: string, sku: string, price: number, name: string, stockOnHand?: number) =>
  ({ id, name, sku, price, currencyCode: 'EUR', enabled: true, trackInventory: stockOnHand === undefined ? 'FALSE' : 'TRUE', stockOnHand });
const products = [
  { id: '1', name: 'Tally Fixture Mug', variants: [variant('11', 'TALLY-MUG', 800, 'Tally Fixture Mug', 50)] },
  { id: '2', name: 'Espresso Beans', variants: [variant('21', 'ESP-250', 899, 'Espresso Beans 250 g', 20), variant('22', 'ESP-1000', 2999, 'Espresso Beans 1 kg', 0)] },
  { id: '3', name: 'Gift Wrapping', variants: [variant('31', 'GFT-WRAP', 300, 'Gift Wrapping')] },
];

describe('productRows', () => {
  it('lists each variant in catalogue order with its name, SKU, price and tracked stock', () => {
    const rows = productRows(products, '', vendureProductTraits, 'EUR', 0);
    expect(rows.map(row => row.id)).toEqual(['11', '21', '22', '31']);
    expect(rows[0]).toEqual({ id: '11', name: 'Tally Fixture Mug', sku: 'TALLY-MUG', price: expect.stringContaining('8.00'), stock: '50',
      priceText: '8.00', stockText: '50', managed: true, editable: true, stockTarget: null });
    expect([rows[1].editable, rows[3].managed, rows[3].stockText]).toEqual([false, false, '']);
    expect(rows[1].name).toBe('Espresso Beans · 250 g');
    expect(rows[1].stock).toBe('20');
    expect(rows[2].stock).toBe('0');
    expect(rows[3].stock).toBe('—');
  });

  it.each([
    ['esp-1000', ['22']],
    ['beans', ['21', '22']],
    ['mug tally', ['11']],
    ['nothing', []],
  ])('filters by %s, keeping an exact SKU alone', (term, ids) => {
    expect(productRows(products, term, vendureProductTraits, 'EUR', 0).map(row => row.id)).toEqual(ids);
  });

  it("shows Manage from the effective setting: a variant on INHERIT follows the store's Track inventory", () => {
    const inherit = [{ id: '4', name: 'House Blend', variants: [{ ...variant('41', 'HSE-BLEND', 1200, 'House Blend', 5), trackInventory: 'INHERIT' }] }];
    const row = (globalTrackInventory: boolean) => productRows(inherit, '',
      createVendureConnector({ pricesIncludeTax: false, globalTrackInventory, globalOutOfStockThreshold: 0 }).traits.product, 'EUR', 0)[0];
    expect([row(true).managed, row(true).stockText]).toEqual([true, '5']);
    expect([row(false).managed, row(false).stock]).toEqual([false, '—']);
  });
});
