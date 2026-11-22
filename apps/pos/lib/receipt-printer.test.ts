import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PrinterProfile, ReceiptData } from '@tallyui/pos';
import { directPrinter, printedOn, printFailed, printFailedAfterClose, printReceiptTo, printTestTo } from './receipt-printer';

// TEST-NET-1: never a real printer. The sinks read globalThis.fetch per request, so a stubbed fetch catches every job.
const epson: PrinterProfile = { id: 'front', name: 'Front counter', connectionType: 'network', vendor: 'epson', address: '192.0.2.10', port: 9100, columns: 42 };
const star: PrinterProfile = { ...epson, id: 'back', name: 'Back office', vendor: 'star' };
const receipt = {
  schemaVersion: '1.4.0',
  software: { name: 'VendurePOS', plugin_version: '', app_version: '', app_build: '', platform: 'web' },
  register: { id: '', name: '' },
  fiscal: { document_type: 'sale', is_reprint: false, reprint_count: 0, qr_payload: '' },
  header: { storeName: 'Demo store', orderNumber: 'DEMO-1', date: '2026-11-22T10:00:00.000Z' },
  lineItems: [{ name: 'Tally Fixture Mug', sku: 'TALLY-MUG', quantity: 1, unitPriceMinor: 952, lineTotalMinor: 952, displayAmountMinor: 952, displayDiscounts: [] }],
  fees: [], shipping: [], discounts: [], orderDiscountMinor: 0,
  totals: { taxInclusive: true, subtotalMinor: 952, discountMinor: 0, taxLines: [], taxMinor: 0, totalMinor: 952 },
  payments: [{ method: 'cash', amountMinor: 1000 }], changeDueMinor: 48, footer: {}, currency: 'EUR',
} satisfies ReceiptData;

const EPOS_OK = '<response success="true" code="" status="251658262" battery="0" />';
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(EPOS_OK, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

// ePOS-Print carries the ESC/POS bytes as hex in <command>.
const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex');

function onlyRequest(): { url: URL; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: new URL(url), init };
}

it('finds no direct printer without an Epson or Star network printer with an address', () => {
  expect(directPrinter([])).toBeNull();
  expect(directPrinter([
    { id: 'usb', name: 'USB', connectionType: 'usb', address: '/dev/usb/lp0' },
    { id: 'bt', name: 'BT', connectionType: 'bluetooth', vendor: 'epson', address: '00:11:22:33:44:55' },
    { ...epson, id: 'generic', vendor: 'generic' },
    { ...epson, id: 'no-address', address: undefined },
  ])).toBeNull();
});

it('takes the Epson network printer, and a default Star printer ahead of it', () => {
  expect(directPrinter([epson])).toBe(epson);
  const defaultStar = { ...star, isDefault: true };
  expect(directPrinter([epson, defaultStar])).toBe(defaultStar);
});

it('prints through the dialog when the thermal templates are routed there', () => {
  expect(directPrinter([epson], { 'thermal-80mm': 'system' })).toBeNull();
});

it('posts a receipt to the Epson printer over ePOS-Print', async () => {
  expect(await printReceiptTo(epson, receipt)).toBeNull();
  const { url, init } = onlyRequest();
  expect(url.hostname).toBe('192.0.2.10');
  expect(url.pathname).toBe('/cgi-bin/epos/service.cgi');
  expect(init.method).toBe('POST');
});

it('posts a receipt to the Star printer over WebPRNT', async () => {
  fetchMock.mockImplementation(async () => new Response('<Status>Normal</Status>', { status: 200 }));
  expect(await printReceiptTo(star, receipt)).toBeNull();
  const { url, init } = onlyRequest();
  expect(url.hostname).toBe('192.0.2.10');
  expect(url.pathname).toBe('/StarWebPRNT/SendMessage');
  expect(init.method).toBe('POST');
});

it('says it cannot print, once, when the printer does not answer', async () => {
  fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  expect(await printReceiptTo(epson, receipt)).toBe(printFailed('Front counter'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('says it cannot print on an error answer', async () => {
  fetchMock.mockImplementation(async () => new Response('', { status: 500 }));
  expect(await printReceiptTo(epson, receipt)).toBe(printFailed('Front counter'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('prints euro amounts the printer can show, not "?"', async () => {
  // The transport's default folds € to the default code page (cp437 has no €) and falls back to the currency code.
  expect(await printReceiptTo(epson, receipt)).toBeNull();
  const body = String(onlyRequest().init.body);
  expect(body).toContain(hex('9.52'));
  expect(body).not.toContain(hex('?9.52'));
});

it('posts a test page to the Epson printer', async () => {
  expect(await printTestTo(epson)).toBeNull();
  const { url, init } = onlyRequest();
  expect(url.hostname).toBe('192.0.2.10');
  expect(init.method).toBe('POST');
  for (const line of ['VendurePOS test print', 'Front counter', '80 mm paper']) expect(String(init.body)).toContain(hex(line));
});

it('words the cashier lines', () => {
  expect(printedOn('Front counter')).toBe('Sent to Front counter.');
  expect(printFailed('Front counter')).toBe("Can't print on Front counter. Check that it is on and on this network, then try again, or print with the dialog.");
  expect(printFailedAfterClose('Front counter')).toBe("Can't print on Front counter. Check that it is on and on this network, then reprint it from Orders.");
});
