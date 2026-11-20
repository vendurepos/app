import { describe, expect, it } from 'vitest';
import { createVendureConnector, vendureProductTraits } from '@tallyui/connector-vendure';
import { filterProductRows, productCategories, productRows, productRowSortValue, sortProductRows, STOCK_STATUS_LABELS, type ProductRow } from './product-rows';

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
      imageUrl: null, stockStatus: 'in_stock', categories: '—', categoryIds: [],
      priceText: '8.00', stockText: '50', managed: true, stockTarget: null });
    expect([rows[3].managed, rows[3].stockText]).toEqual([false, '']);
    expect(rows[1].name).toBe('Espresso Beans · 250 g');
    expect(rows[1].stock).toBe('20');
    expect(rows[2].stock).toBe('0');
    expect(rows[3].stock).toBe('—');
  });

  it('includes the product image and categories and each variant\'s stock status', () => {
    const rows = productRows([
      { ...products[0], featuredAsset: { preview: 'https://example.test/mug.jpg' },
        collections: [{ id: '1', name: 'Kitchen' }, { id: '2', name: 'Gifts' }] },
      products[1],
    ], '', vendureProductTraits, 'EUR', 0);
    expect(rows[0].imageUrl).toBe('https://example.test/mug.jpg');
    expect(rows[1].imageUrl).toBeNull();
    expect(rows[0].categories).toBe('Kitchen, Gifts');
    expect(rows[1].categories).toBe('—');
    expect(rows[0].categoryIds).toEqual(['1', '2']);
    expect(rows[1].categoryIds).toEqual([]);
    expect(rows[0].stockStatus).toBe('in_stock');
    expect(rows[2].stockStatus).toBe('out_of_stock');
  });

  it('labels all four stock statuses as in v2', () => {
    expect(STOCK_STATUS_LABELS).toEqual({
      in_stock: 'In stock', out_of_stock: 'Out of stock', backorder: 'On backorder', unknown: '—',
    });
  });

  it('keeps each Espresso Beans variant\'s own id, price and stock edit values', () => {
    const rows = productRows(products, 'Espresso Beans', vendureProductTraits, 'EUR', 0);
    expect(rows.map(({ id, priceText, stockText }) => ({ id, priceText, stockText }))).toEqual([
      { id: '21', priceText: '8.99', stockText: '20' },
      { id: '22', priceText: '29.99', stockText: '0' },
    ]);
  });

  it('builds each row\'s stock target from its own variant\'s stock level', () => {
    const stocked = products.map(product => ({ ...product, variants: product.variants.map((v, index) => ({ ...v,
      stockLevels: [{ stockLocationId: `location-${v.id}`, stockOnHand: v.stockOnHand ?? 0, stockAllocated: index + 1 }],
    })) }));
    const rows = productRows(stocked, 'Espresso Beans', vendureProductTraits, 'EUR', 3);
    expect(rows.map(({ id, stockTarget }) => ({ id, stockTarget }))).toEqual([
      { id: '21', stockTarget: { stockLocationId: 'location-21', stockAllocated: 1, threshold: 3 } },
      { id: '22', stockTarget: { stockLocationId: 'location-22', stockAllocated: 2, threshold: 3 } },
    ]);
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

describe('filterProductRows', () => {
  const base = productRows(products, '', vendureProductTraits, 'EUR', 0);
  const rows: ProductRow[] = [
    { ...base[0], stockStatus: 'in_stock', categoryIds: ['kitchen'] },
    { ...base[2], stockStatus: 'out_of_stock', categoryIds: ['kitchen'] },
    { ...base[1], stockStatus: 'backorder', categoryIds: ['coffee'] },
    { ...base[3], stockStatus: 'unknown', categoryIds: [] },
  ];

  it('drops only out-of-stock rows when In Stock is on', () => {
    expect(filterProductRows(rows, { inStock: true, categoryId: null })).toEqual([rows[0], rows[2], rows[3]]);
  });

  it('keeps only rows with the selected category id', () => {
    expect(filterProductRows(rows, { inStock: false, categoryId: 'kitchen' })).toEqual([rows[0], rows[1]]);
  });

  it('applies In Stock and category together', () => {
    expect(filterProductRows(rows, { inStock: true, categoryId: 'kitchen' })).toEqual([rows[0]]);
  });

  it('keeps every row in order when neither filter is set', () => {
    expect(filterProductRows(rows, { inStock: false, categoryId: null })).toEqual(rows);
  });
});

describe('Products panel header sorting', () => {
  const row = (values: Partial<ProductRow> = {}): ProductRow => ({
    id: '1', name: 'Mug', sku: '—', price: '—', stock: '—', imageUrl: null,
    stockStatus: 'unknown', categories: '—', categoryIds: [], priceText: '', stockText: '',
    managed: false, stockTarget: null, ...values,
  });

  it('extracts header values, leaving missing and unsortable values undefined', () => {
    expect(productRowSortValue(row(), 'name')).toBe('Mug');
    expect(productRowSortValue(row(), 'sku')).toBeUndefined();
    expect(productRowSortValue(row({ stockText: '12' }), 'stock')).toBe(12);
    expect(productRowSortValue(row(), 'stock')).toBeUndefined();
    expect(productRowSortValue(row({ priceText: '8.50' }), 'price')).toBe(8.5);
    expect(productRowSortValue(row(), 'price')).toBeUndefined();
    expect(productRowSortValue(row(), 'categories')).toBeUndefined();
  });

  it('keeps the same catalogue array when no sort is selected', () => {
    const rows = [row(), row({ id: '2' })];
    expect(sortProductRows(rows, null)).toBe(rows);
  });

  it('sorts prices numerically and keeps missing prices last in either direction', () => {
    const rows = [row({ id: '10', priceText: '10.00' }), row(), row({ id: '9', priceText: '9.00' })];
    expect(sortProductRows(rows, { field: 'price', dir: 'asc' })).toEqual([rows[2], rows[0], rows[1]]);
    expect(sortProductRows(rows, { field: 'price', dir: 'desc' })).toEqual([rows[0], rows[2], rows[1]]);
  });

  it('sorts names descending and keeps equal names in input order', () => {
    const rows = [row({ id: 'a', name: 'a' }), row({ id: 'b1', name: 'b' }), row({ id: 'b2', name: 'b' })];
    expect(sortProductRows(rows, { field: 'name', dir: 'desc' })).toEqual([rows[1], rows[2], rows[0]]);
  });

  it('brings the cheapest row from beyond the first page to the front', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ id: String(i), priceText: i === 29 ? '1.00' : '10.00' }));
    expect(sortProductRows(rows, { field: 'price', dir: 'asc' })[0]).toBe(rows[29]);
  });
});

describe('productCategories', () => {
  it('dedupes collections by id and sorts them by name', () => {
    const kitchen = { id: '1', name: 'Kitchen' };
    const coffee = { id: '2', name: 'Coffee' };
    expect(productCategories([
      { ...products[0], collections: [kitchen] },
      { ...products[1], collections: [kitchen, coffee] },
    ], vendureProductTraits)).toEqual([coffee, kitchen]);
  });
});
