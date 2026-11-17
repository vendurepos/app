import { afterEach, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { PRODUCT_SAVE_FAILED_TEXT, PRODUCT_SAVE_FORBIDDEN_TEXT, STOCK_CHANGED_TEXT, canEditCatalogue, catalogueEditable, checkStockEdit, saveVariantUpdate,
  stockTarget, variantUpdateInput } from './product-edit';

afterEach(() => vi.unstubAllGlobals());
const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

it.each([
  ['EUR', '9.50', 950], ['EUR', '9.5', 950], ['EUR', ' 12 ', 1200], ['EUR', '0.29', 29], ['JPY', '950', 950],
  ['EUR', '1.005', null], ['EUR', '-1', null], ['EUR', '', null], ['EUR', 'abc', null], ['EUR', '9,50', null], ['JPY', '9.5', null],
])('reads the price %s %j as %j minor units', (currency, text, price) => {
  expect(variantUpdateInput('7', { field: 'price', text }, currency)).toEqual(price === null ? null : { id: '7', price });
});

const target = { stockLocationId: '3', stockAllocated: 2, threshold: 1 };
it.each([['10', 13], ['0', 3], ['-1', null], ['1.5', null], ['', null], ['x', null]])('writes saleable stock %j as on hand %j', (text, stockOnHand) => {
  expect(variantUpdateInput('7', { field: 'stock', text, target }, 'EUR'))
    .toEqual(stockOnHand === null ? null : { id: '7', stockLevels: [{ stockLocationId: '3', stockOnHand }] });
});

const level = { stockLocationId: '3', stockAllocated: 2 };
it.each([
  [{ stockLevels: [level] }, { stockLocationId: '3', stockAllocated: 2, threshold: 5 }],
  [{ stockLevels: [level], useGlobalOutOfStockThreshold: false, outOfStockThreshold: 4 }, { stockLocationId: '3', stockAllocated: 2, threshold: 4 }],
  [{ stockLevels: [level, { stockLocationId: '4', stockAllocated: 0 }] }, null],
  [{}, null],
  [undefined, null],
])('finds the stock target of %j', (variant, expected) => {
  expect(stockTarget(variant, 5)).toEqual(expected);
});

it('maps the manage-stock switch to trackInventory', () => {
  expect(variantUpdateInput('7', { field: 'manage', on: true }, 'EUR')).toEqual({ id: '7', trackInventory: 'TRUE' });
  expect(variantUpdateInput('7', { field: 'manage', on: false }, 'EUR')).toEqual({ id: '7', trackInventory: 'FALSE' });
});

it.each([[['ReadCatalog', 'UpdateCatalog'], true], [['UpdateProduct'], true], [['ReadCatalog'], false], [[], false]])(
  'lets %j edit the catalogue: %j', (permissions, expected) => { expect(canEditCatalogue(permissions)).toBe(expected); });

const till = { currency: 'EUR', pricesIncludeTax: false };
it("reads the active channel's permissions", async () => {
  const channels = [{ id: '1', permissions: ['ReadCatalog'] }, { id: '2', permissions: ['UpdateCatalog'] }];
  vi.stubGlobal('fetch', respond({ data: { me: { channels }, activeChannel: { id: '1' } } }));
  expect((await catalogueEditable(context, till)).editable).toBe(false);
  vi.stubGlobal('fetch', respond({ data: { me: { channels }, activeChannel: { id: '2' } } }));
  expect((await catalogueEditable(context, till)).editable).toBe(true);
});

const editor = (activeChannel: object) => respond({ data: { me: { channels: [{ id: '2', permissions: ['UpdateCatalog'] }] }, activeChannel: { id: '2', ...activeChannel } } });
it("offers the price edit only when the till's currency is the channel's default currency", async () => {
  vi.stubGlobal('fetch', editor({ defaultCurrencyCode: 'EUR', pricesIncludeTax: false }));
  expect(await catalogueEditable(context, till)).toEqual({ editable: true, priceEditable: true });
  vi.stubGlobal('fetch', editor({ defaultCurrencyCode: 'USD', pricesIncludeTax: false }));
  expect(await catalogueEditable(context, till)).toEqual({ editable: true, priceEditable: false });
  expect(JSON.parse((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body as string).query)
    .toContain('activeChannel { id defaultCurrencyCode pricesIncludeTax }');
});

it("offers the price edit only when the channel's tax mode is the one the till shows", async () => {
  vi.stubGlobal('fetch', editor({ defaultCurrencyCode: 'EUR', pricesIncludeTax: true }));
  expect(await catalogueEditable(context, till)).toEqual({ editable: true, priceEditable: false });
  expect(await catalogueEditable(context, { ...till, pricesIncludeTax: true })).toEqual({ editable: true, priceEditable: true });
  vi.stubGlobal('fetch', respond({ data: { me: { channels: [{ id: '2', permissions: ['ReadCatalog'] }] },
    activeChannel: { id: '2', defaultCurrencyCode: 'EUR', pricesIncludeTax: false } } }));
  expect(await catalogueEditable(context, till)).toEqual({ editable: false, priceEditable: false });
});

// Synced: allocated 2, threshold 1. In the store now: on hand 20, allocated 4, the variant's own threshold 3, so saleable 13.
const synced = { field: 'stock' as const, text: '10', target };
const level20 = (variant: object = {}) => respond({ data: { globalSettings: { outOfStockThreshold: 9 }, productVariant: {
  stockLevels: [{ stockLocationId: '3', stockOnHand: 20, stockAllocated: 4 }], useGlobalOutOfStockThreshold: false, outOfStockThreshold: 3, ...variant } } });
it('writes stock from the fresh allocated and threshold, not the synced ones', async () => {
  const fetch = level20();
  vi.stubGlobal('fetch', fetch);
  expect(await checkStockEdit(context, '7', synced, '13')).toEqual({ id: '7', stockLevels: [{ stockLocationId: '3', stockOnHand: 17 }] });
  const request = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(request.variables).toEqual({ id: '7' });
  expect(request.query).toContain('productVariant(id: $id)');
  // A variant on the global threshold takes the store's global figure: saleable 20 - 4 - 9 = 7, on hand 10 + 4 + 9.
  vi.stubGlobal('fetch', level20({ useGlobalOutOfStockThreshold: true }));
  expect(await checkStockEdit(context, '7', synced, '7')).toEqual({ id: '7', stockLevels: [{ stockLocationId: '3', stockOnHand: 23 }] });
});

it("refuses a stock write when the fresh saleable figure differs from the row's", async () => {
  vi.stubGlobal('fetch', level20());
  expect(await checkStockEdit(context, '7', synced, '15')).toBe(STOCK_CHANGED_TEXT);
  // Saleable never goes below 0, as the connector's variantStock shows it: on hand 5 less allocated 4 less threshold 3 is 0.
  vi.stubGlobal('fetch', level20({ stockLevels: [{ stockLocationId: '3', stockOnHand: 5, stockAllocated: 4 }] }));
  expect(await checkStockEdit(context, '7', synced, '-2')).toBe(STOCK_CHANGED_TEXT);
  expect(await checkStockEdit(context, '7', synced, '0')).toEqual({ id: '7', stockLevels: [{ stockLocationId: '3', stockOnHand: 17 }] });
});

it('writes nothing when the stock refetch fails', async () => {
  for (const reply of [
    vi.fn(async () => new Response('{}', { status: 500 })), vi.fn(async () => { throw new Error('offline'); }),
    respond({ errors: [{ message: 'boom' }] }), respond({ data: { productVariant: null, globalSettings: { outOfStockThreshold: 0 } } }),
    respond({ data: { productVariant: { stockLevels: [] }, globalSettings: { outOfStockThreshold: 0 } } }),
  ]) {
    vi.stubGlobal('fetch', reply);
    expect(await checkStockEdit(context, '7', synced, '13')).toBe(PRODUCT_SAVE_FAILED_TEXT);
    expect(reply).toHaveBeenCalledTimes(1);
  }
});

it('saves one variant update and names a refusal', async () => {
  const fetch = respond({ data: { updateProductVariants: [{ id: '7' }] } });
  vi.stubGlobal('fetch', fetch);
  expect(await saveVariantUpdate(context, { id: '7', price: 950 })).toBeNull();
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).variables.input).toEqual([{ id: '7', price: 950 }]);
  vi.stubGlobal('fetch', respond({ errors: [{ message: 'x', extensions: { code: 'FORBIDDEN' } }] }));
  expect(await saveVariantUpdate(context, { id: '7', price: 950 })).toBe(PRODUCT_SAVE_FORBIDDEN_TEXT);
  vi.stubGlobal('fetch', respond({ errors: [{ message: 'boom' }] }));
  expect(await saveVariantUpdate(context, { id: '7', price: 950 })).toBe(PRODUCT_SAVE_FAILED_TEXT);
});
