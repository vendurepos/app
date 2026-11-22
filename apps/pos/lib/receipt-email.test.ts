import { afterEach, expect, it, vi } from 'vitest';
import type { ServerCapabilities, SyncContext } from '@tallyui/core';
import { RECEIPT_EMAIL_DAILY_LIMIT_TEXT, RECEIPT_EMAIL_DISABLED_TEXT, RECEIPT_EMAIL_FAILED_TEXT, RECEIPT_EMAIL_FORBIDDEN_TEXT,
  RECEIPT_EMAIL_INVALID_TEXT, RECEIPT_EMAIL_NOT_TILL_ORDER_TEXT, RECEIPT_EMAIL_ORDER_GONE_TEXT, RECEIPT_EMAIL_ORDER_LIMIT_TEXT,
  RECEIPT_EMAIL_RATE_LIMITED_TEXT, RECEIPT_EMAIL_TIMEOUT_MS, RECEIPT_EMAIL_UNAUTHORIZED_TEXT, RECEIPT_EMAIL_UNKNOWN_TEXT, canEmailReceipt,
  sendReceiptEmail } from './receipt-email';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const context = { baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' } } as unknown as SyncContext;
const respond = (status: number, body?: unknown) => vi.fn(async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status }));

it.each([[undefined, false], [{ receiptEmail: undefined }, false], [{ receiptEmail: 1 }, true], [{ receiptEmail: 2 }, true]])(
  'emails receipts for capabilities %j: %j', (capabilities, expected) => {
    expect(canEmailReceipt(capabilities as ServerCapabilities | undefined)).toBe(expected);
  });

it('posts the trimmed address to the encoded order code once, with the context headers', async () => {
  const fetch = respond(202, { queued: true, emailAddress: 'a@b.co' });
  vi.stubGlobal('fetch', fetch);
  expect(await sendReceiptEmail(context, 'AB/C 1', '  a@b.co ')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://store.test/tally/v1/orders/AB%2FC%201/receipt-email');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer t' });
  expect(JSON.parse(init.body as string)).toEqual({ emailAddress: 'a@b.co' });
});

it.each([
  [202, { queued: true }, null],
  [200, { queued: true }, RECEIPT_EMAIL_FAILED_TEXT],
  [202, {}, RECEIPT_EMAIL_FAILED_TEXT],
  [202, '<html>Proxy page</html>', RECEIPT_EMAIL_FAILED_TEXT],
  [404, { code: 'receipt_email_disabled' }, RECEIPT_EMAIL_DISABLED_TEXT],
  [404, {}, RECEIPT_EMAIL_DISABLED_TEXT],
  [403, { code: 'forbidden' }, RECEIPT_EMAIL_FORBIDDEN_TEXT],
  [403, {}, RECEIPT_EMAIL_UNAUTHORIZED_TEXT],
  [401, {}, RECEIPT_EMAIL_UNAUTHORIZED_TEXT],
  [400, { code: 'invalid_payload' }, RECEIPT_EMAIL_INVALID_TEXT],
  [404, { code: 'order_not_found' }, RECEIPT_EMAIL_ORDER_GONE_TEXT],
  [409, { code: 'not_till_order' }, RECEIPT_EMAIL_NOT_TILL_ORDER_TEXT],
  [422, { code: 'no_recipient' }, RECEIPT_EMAIL_INVALID_TEXT],
  [429, { code: 'rate_limited' }, RECEIPT_EMAIL_RATE_LIMITED_TEXT],
  [429, { code: 'order_send_limit' }, RECEIPT_EMAIL_ORDER_LIMIT_TEXT],
  [429, { code: 'channel_daily_limit' }, RECEIPT_EMAIL_DAILY_LIMIT_TEXT],
  [429, { code: 'something_new' }, RECEIPT_EMAIL_FAILED_TEXT],
  [500, {}, RECEIPT_EMAIL_FAILED_TEXT],
  [500, '<html>Server error</html>', RECEIPT_EMAIL_FAILED_TEXT],
  [502, {}, RECEIPT_EMAIL_UNKNOWN_TEXT],
  [503, '<html>Unavailable</html>', RECEIPT_EMAIL_UNKNOWN_TEXT],
  [504, {}, RECEIPT_EMAIL_UNKNOWN_TEXT],
])('reads a %i %j as %j', async (status, body, expected) => {
  vi.stubGlobal('fetch', respond(status, body));
  expect(await sendReceiptEmail(context, 'DEMO-000001', 'a@b.co')).toBe(expected);
});

it('adds the retry time to a daily limit that carries one', async () => {
  const retryAt = '2026-11-23T10:00:00.000Z';
  vi.stubGlobal('fetch', respond(429, { code: 'user_daily_limit', retryAt }));
  expect(await sendReceiptEmail(context, 'DEMO-000001', 'a@b.co'))
    .toBe(`${RECEIPT_EMAIL_DAILY_LIMIT_TEXT} Try again after ${new Date(retryAt).toLocaleString()}.`);
});

it('never retries a send whose request threw', async () => {
  const fetch = vi.fn(async () => { throw new TypeError('network'); });
  vi.stubGlobal('fetch', fetch);
  expect(await sendReceiptEmail(context, 'DEMO-000001', 'a@b.co')).toBe(RECEIPT_EMAIL_UNKNOWN_TEXT);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([408, 524])('reads a %i as may or may not have been sent, and never retries it', async (status) => {
  const fetch = respond(status, '<html>Timed out</html>');
  vi.stubGlobal('fetch', fetch);
  expect(await sendReceiptEmail(context, 'DEMO-000001', 'a@b.co')).toBe(RECEIPT_EMAIL_UNKNOWN_TEXT);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('ends a send that never answers when the timeout fires, as may or may not have been sent, and never retries it', async () => {
  vi.useFakeTimers();
  // A real fetch rejects with an AbortError when its signal aborts.
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetch);
  const sent = sendReceiptEmail(context, 'DEMO-000001', 'a@b.co');
  await vi.advanceTimersByTimeAsync(RECEIPT_EMAIL_TIMEOUT_MS - 1);
  expect(fetch.mock.calls[0][1].signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await sent).toBe(RECEIPT_EMAIL_UNKNOWN_TEXT);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reads a 202 whose body never arrives before the timeout as may or may not have been sent, never as try again', async () => {
  vi.useFakeTimers();
  // The store accepted; its body read rejects only when the signal aborts, as a real stalled stream does.
  const fetch = vi.fn(async (_url: string, init: RequestInit) => Object.assign(new Response(null, { status: 202 }), {
    json: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  }));
  vi.stubGlobal('fetch', fetch);
  const sent = sendReceiptEmail(context, 'DEMO-000001', 'a@b.co');
  await vi.advanceTimersByTimeAsync(RECEIPT_EMAIL_TIMEOUT_MS);
  expect(await sent).toBe(RECEIPT_EMAIL_UNKNOWN_TEXT);
  expect(fetch).toHaveBeenCalledTimes(1);
});
