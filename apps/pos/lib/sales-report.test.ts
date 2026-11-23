import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSalesReport, fetchSalesReportV2, type SalesReportV2, type SalesReportV3 } from './sales-report';
import type { Session } from './session';
import { NO_MARGIN, reportsView, storeAnswer, storeSalesFigures } from './store-sales';

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

describe('fetchSalesReport', () => {
  const day = { from: '2026-11-17', to: '2026-11-17' };
  // v2's figures plus 8.1q's: two orders (400 and 600) and a mug in two collections, counted in each.
  const v3: SalesReportV3 = {
    ...report, version: 3, orders: { ...report.orders, count: 2, medianMinor: 500, largestMinor: 600 },
    categories: [
      { collectionId: 'T_2', name: 'Gifts', quantity: 2, salesMinor: 1000 },
      { collectionId: 'T_1', name: 'Drinkware', quantity: 2, salesMinor: 1000 },
    ],
  };
  const path = (call: number) => new URL(String(fetchMock.mock.calls[call][0])).pathname;
  const params = (call: number) => Object.fromEntries(new URL(String(fetchMock.mock.calls[call][0])).searchParams);
  const neverTill = () => { throw new Error('the store view never reads the till'); };

  it('asks v3 first, and maps its median, largest and categories as products map', async () => {
    fetchMock.mockResolvedValue(Response.json(v3));
    const outcome = await fetchSalesReport(session, query);
    expect(outcome).toEqual({ status: 'ok', report: v3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(path(0)).toBe('/tally/v1/reports/sales/v3');
    const figures = storeSalesFigures(v3, null, day, day);
    expect(figures.totals).toMatchObject({ medianMinor: 500, largestMinor: 600 });
    // Equal sales and quantity fall back to the name, as products do.
    expect(figures.categories).toEqual([
      { key: 'T_1', name: 'Drinkware', quantity: 2, netMinor: 1000, margin: NO_MARGIN },
      { key: 'T_2', name: 'Gifts', quantity: 2, netMinor: 1000, margin: NO_MARGIN },
    ]);
    expect(figures.products).toEqual([{ key: 'T_1', name: 'Mug', quantity: 2, netMinor: 1000, margin: NO_MARGIN }]);
    // A v3 answer shows the Categories card in the store's view.
    expect(reportsView(storeAnswer(outcome, outcome, day, day, true), neverTill, []).hide).toEqual([]);
  });

  it('falls back to v2 on a v3 404, without median, largest or categories', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(report));
    const signal = new AbortController().signal;
    const outcome = await fetchSalesReport(session, { ...query, cashierId: 'cashier-1' }, { signal });
    expect(outcome).toEqual({ status: 'ok', report });
    expect([path(0), path(1)]).toEqual(['/tally/v1/reports/sales/v3', '/tally/v1/reports/sales/v2']);
    expect(params(1)).toEqual({ ...query, cashierId: 'cashier-1' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ signal });
    const figures = storeSalesFigures(report, null, day, day);
    expect(figures.totals.medianMinor).toBeUndefined();
    expect(figures.totals.largestMinor).toBeUndefined();
    expect(figures.categories).toEqual([]);
    expect(reportsView(storeAnswer(outcome, outcome, day, day, true), neverTill, []).hide).toEqual(['categories']);
  });

  it('answers unsupported when v2 is missing too, and never falls back from a refusal', async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));
    expect(await fetchSalesReport(session, query)).toEqual({ status: 'unsupported' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' }, { status: 403 }));
    expect(await fetchSalesReport(session, query)).toEqual({ status: 'forbidden' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
