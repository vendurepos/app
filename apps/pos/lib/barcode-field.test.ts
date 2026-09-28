import type { SyncContext } from '@tallyui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasVariantCustomField, isFieldName } from './barcode-field';

const context: SyncContext = {
  connectorId: 'vendure', baseUrl: 'https://shop.example.com',
  headers: { Authorization: 'Bearer test-token', 'vendure-token': 'channel-1' },
  signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());

describe('isFieldName', () => {
  it.each(['barcode', 'ean_13'])('accepts %s', (name) => expect(isFieldName(name)).toBe(true));
  it.each(['bar code', '1abc', 'x{y}'])('refuses %s', (name) => expect(isFieldName(name)).toBe(false));
});

describe('hasVariantCustomField', () => {
  it('accepts data and sends the field, authenticated channel headers and signal', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      data: { productVariants: { items: [{ customFields: { barcode: '2000000000015' } }] } },
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await hasVariantCustomField(context, 'barcode')).toBe(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal,
      body: JSON.stringify({ query: '{ productVariants(options: { take: 1 }) { items { customFields { barcode } } } }' }),
    });
  });

  it.each([
    [{ errors: [{ message: 'Unknown field' }] }, 200],
    [{ data: { productVariants: { items: [] } }, errors: [{ message: 'Failure' }] }, 200],
    [{ data: { productVariants: { items: [] } } }, 400],
    [{ data: {} }, 200],
    [{ data: { productVariants: null } }, 200],
  ])('rejects unsuccessful body %j with status %s', async (body, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
    expect(await hasVariantCustomField(context, 'barcode')).toBe(false);
  });

  it('returns false for a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await hasVariantCustomField(context, 'barcode')).toBe(false);
  });

  it('returns false for invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));
    expect(await hasVariantCustomField(context, 'barcode')).toBe(false);
  });
});
