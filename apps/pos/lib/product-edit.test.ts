import { afterEach, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { PRODUCT_SAVE_FAILED_TEXT, PRODUCT_SAVE_FORBIDDEN_TEXT, canEditCatalogue, catalogueEditable, saveVariantUpdate, stockTarget,
  variantUpdateInput } from './product-edit';

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

it("reads the active channel's permissions", async () => {
  const channels = [{ id: '1', permissions: ['ReadCatalog'] }, { id: '2', permissions: ['UpdateCatalog'] }];
  vi.stubGlobal('fetch', respond({ data: { me: { channels }, activeChannel: { id: '1' } } }));
  expect(await catalogueEditable(context)).toBe(false);
  vi.stubGlobal('fetch', respond({ data: { me: { channels }, activeChannel: { id: '2' } } }));
  expect(await catalogueEditable(context)).toBe(true);
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
