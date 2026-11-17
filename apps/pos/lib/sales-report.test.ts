import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSalesReportV2, type SalesReportV2 } from './sales-report';
import type { Session } from './session';

const session: Session = {
  url: 'https://shop.example.com', email: 'till@example.com', token: 'session-token', channelToken: 'channel-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 0 } },
  stock: { trackInventory: false, outOfStockThreshold: 0 },
};
const query = { from: '2026-11-17T00:00:00+01:00', to: '2026-11-18T00:00:00+01:00', timezone: 'Europe/Berlin' };
const report: SalesReportV2 = {
  version: 2, ...query, currencyCode: 'EUR', registerId: null, cashierId: null,
  orders: { count: 1, salesMinor: 1000, taxMinor: 200, discountsMinor: 0, itemCount: 2 },
  refunds: { count: 0, totalMinor: 0, orderCount: 0 },
  byMethod: [{ method: 'cash', salesMinor: 1000, refundsMinor: 0, orderCount: 1, refundCount: 0 }],
  byDay: [{ day: '2026-11-17', orderCount: 1, salesMinor: 1000, refundsMinor: 0 }],
  byHour: [{ hour: '2026-11-17T10', orderCount: 1, salesMinor: 1000, refundsMinor: 0 }],
  products: [{ productVariantId: 'T_1', sku: 'mug', name: 'Mug', quantity: 2, salesMinor: 1000 }],
  productsTruncated: false,
  taxes: [{ description: 'Standard', ratePercent: 25, baseMinor: 800, taxMinor: 200 }],
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSalesReportV2', () => {
  it('reads the v2 route with the session headers and only the given filters', async () => {
    fetchMock.mockResolvedValue(Response.json(report));
    expect(await fetchSalesReportV2(session, query)).toEqual({ status: 'ok', report });
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe('https://shop.example.com/tally/v1/reports/sales/v2');
    expect(Object.fromEntries(parsed.searchParams)).toEqual(query);
    expect(init).toEqual({ headers: { Authorization: 'Bearer session-token', 'vendure-token': 'channel-token' }, signal: undefined });
  });

  it('passes registerId, cashierId and the signal through, and a device key as its own header', async () => {
    fetchMock.mockResolvedValue(Response.json(report));
    const signal = new AbortController().signal;
    await fetchSalesReportV2({ ...session, kind: 'api-key', apiKey: 'device-key', channelToken: undefined },
      { ...query, registerId: 'register-1', cashierId: 'cashier-1' }, { signal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ ...query, registerId: 'register-1', cashierId: 'cashier-1' });
    expect(init).toEqual({ headers: { 'vendure-api-key': 'device-key' }, signal });
  });

  it('answers unsupported for an older plugin (404)', async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));
    expect(await fetchSalesReportV2(session, query)).toEqual({ status: 'unsupported' });
  });

  it('answers forbidden without TallyPosSell and ReadOrder (403)', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' }, { status: 403 }));
    expect(await fetchSalesReportV2(session, query)).toEqual({ status: 'forbidden' });
  });

  it('answers error with the server message, or the status when there is none', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'invalid_query', message: 'cashierId must be 1 to 64 characters' }, { status: 400 }));
    expect(await fetchSalesReportV2(session, query)).toEqual({ status: 'error', message: 'cashierId must be 1 to 64 characters' });
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    expect(await fetchSalesReportV2(session, query)).toEqual({ status: 'error', message: 'Sales report failed (HTTP 500)' });
  });

  it('answers error when the request fails, and rethrows an abort', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await fetchSalesReportV2(session, query)).toEqual({ status: 'error', message: 'Network request failed' });
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(fetchSalesReportV2(session, query)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
