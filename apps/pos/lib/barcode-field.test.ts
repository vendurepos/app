import type { SyncContext } from '@tallyui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBarcodeField, isFieldName } from './barcode-field';

const context: SyncContext = {
  connectorId: 'vendure', baseUrl: 'https://shop.example.com',
  headers: { Authorization: 'Bearer test-token', 'vendure-token': 'channel-1' },
  signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());

describe('isFieldName', () => {
  it.each(['barcode', 'ean_13'])('accepts %s', (name) => expect(isFieldName(name)).toBe(true));
  it.each(['bar code', '1abc', 'x{y}', '__typename'])('refuses %s', (name) => expect(isFieldName(name)).toBe(false));
});

describe('checkBarcodeField', () => {
  it.each(['string', 'text'])('accepts %s and sends the config query, authenticated channel headers and signal', async (type) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      data: { globalSettings: { serverConfig: { entityCustomFields: [
        { entityName: 'Product', customFields: [{ name: 'barcode', type: 'int', list: false }] },
        { entityName: 'ProductVariant', customFields: [{ name: 'other', type: 'int', list: false }, { name: 'barcode', type, list: false }] },
      ] } } },
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await checkBarcodeField(context, 'barcode')).toBe('ok');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal,
      body: JSON.stringify({ query: '{ globalSettings { serverConfig { entityCustomFields { entityName customFields { ... on CustomField { name type list } } } } } }' }),
    });
  });

  it.each([
    ['int', false, 'wrong_type'], ['string', true, 'wrong_type'], ['string', false, 'missing'],
  ] as const)('checks %s with list %s and result %s', async (type, list, result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      data: { globalSettings: { serverConfig: { entityCustomFields: [
        { entityName: 'ProductVariant', customFields: [{ name: result === 'missing' ? 'other' : 'barcode', type, list }] },
      ] } } },
    })));
    expect(await checkBarcodeField(context, 'barcode')).toBe(result);
  });

  it.each([
    [{ errors: [{ message: 'Unknown field' }, { message: 'Second error' }] }, 200, 'Unknown field'],
    [{ data: { globalSettings: null }, errors: [{ message: 'Failure' }] }, 200, 'Failure'],
    [{}, 403, 'HTTP 403'],
    [{ data: {} }, 200, expect.any(String)],
    [{ data: { globalSettings: null } }, 200, expect.any(String)],
  ])('reports unsuccessful body %j with status %s', async (body, status, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
    expect(await checkBarcodeField(context, 'barcode')).toEqual({ error });
  });

  it('reports a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await checkBarcodeField(context, 'barcode')).toEqual({ error: 'Failed to fetch' });
  });

  it('reports invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));
    expect(await checkBarcodeField(context, 'barcode')).toEqual({ error: expect.any(String) });
  });

  it('rethrows when the signal is aborted', async () => {
    const controller = new AbortController();
    const error = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { controller.abort(); throw error; }));
    await expect(checkBarcodeField({ ...context, signal: controller.signal }, 'barcode')).rejects.toBe(error);
  });
});
