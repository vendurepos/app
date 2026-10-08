import { afterEach, expect, it, vi } from 'vitest';
import { DEMO_CAPTURE_URL, demoAnalyticsEnabled, trackDemoEvent, withDemoSaleEvent, type DemoEvent } from './analytics';

afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  [true, 'demo.vendurepos.com', true],
  [true, 'localhost', false],
  [true, '127.0.0.1', false],
  [true, 'vendurepos.com', false],
  [true, undefined, false],
  [false, 'demo.vendurepos.com', false],
] as const)('enables analytics for demo=%s, hostname=%s: %s', (demo, hostname, enabled) => {
  expect(demoAnalyticsEnabled(demo, hostname)).toBe(enabled);
});

it('sends one anonymous, cookieless capture with only the specified properties', () => {
  const fetch = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetch);
  trackDemoEvent('demo_opened', true);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(DEMO_CAPTURE_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: expect.any(String),
    credentials: 'omit', keepalive: true,
  });
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body).toEqual({
    api_key: 'phc_BhTJzZ7fXMqcD4MiaUJQsQqPkEpu94yoSAthXFBWemvd', event: 'demo_opened',
    distinct_id: expect.any(String), properties: { site: 'demo.vendurepos.com', $process_person_profile: false, $referring_domain: '$direct' },
  });
  expect(body.distinct_id.length).toBeGreaterThan(0);
});

it.each([
  ['', '$direct'],
  ['https://vendurepos.com/', 'vendurepos.com'],
  ['https://docs.vendurepos.com/quick-start?utm_source=newsletter#try', 'docs.vendurepos.com'],
])('records only the referring host or $direct for referrer %s', (referrer, domain) => {
  const fetch = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', { referrer });
  trackDemoEvent('demo_opened', true);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.properties).toEqual({ site: 'demo.vendurepos.com', $process_person_profile: false, $referring_domain: domain });
  expect(fetch.mock.calls[0][1].body).not.toContain('quick-start');
  expect(fetch.mock.calls[0][1].body).not.toContain('utm_source');
});

it.each(['demo_signed_in', 'demo_sale_completed', 'demo_reset'] as const)('omits the referring domain for %s', (event) => {
  const fetch = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', { referrer: 'https://vendurepos.com/' });
  trackDemoEvent(event, true);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.properties).toEqual({ site: 'demo.vendurepos.com', $process_person_profile: false });
});

it('uses the same in-memory visit id for successive events', () => {
  const fetch = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetch);
  trackDemoEvent('demo_opened', true);
  trackDemoEvent('demo_signed_in', true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[0][1].body).distinct_id)
    .toBe(JSON.parse(fetch.mock.calls[1][1].body).distinct_id);
});

it('sends no event when disabled explicitly or by the normal-build default', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('location', { hostname: 'demo.vendurepos.com' });
  const events: DemoEvent[] = ['demo_opened', 'demo_signed_in', 'demo_sale_completed', 'demo_reset'];
  for (const event of events) {
    trackDemoEvent(event, false);
    trackDemoEvent(event);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['rejecting', 'throwing', 'missing'])('silently swallows a %s fetch', async (kind) => {
  const error = new Error('capture failed');
  const fetch = kind === 'missing' ? undefined : vi.fn(() => {
    if (kind === 'throwing') throw error;
    return Promise.reject(error);
  });
  vi.stubGlobal('fetch', fetch);
  expect(() => trackDemoEvent('demo_opened', true)).not.toThrow();
  // Vitest reports any unhandled rejection during this macrotask as a test failure.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it('does not read or write localStorage or sessionStorage', () => {
  const fetch = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetch);
  const stores = Array.from({ length: 2 }, () => ({
    getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
  }));
  vi.stubGlobal('localStorage', stores[0]);
  vi.stubGlobal('sessionStorage', stores[1]);
  trackDemoEvent('demo_opened', true);
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const store of stores) {
    for (const spy of Object.values(store)) expect(spy).not.toHaveBeenCalled();
  }
});

it('records the sale before sending its event and waits until recording resolves', async () => {
  const fetch = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetch);
  let resolve!: () => void;
  const record = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  const order = { id: 'sale' };
  const completed = withDemoSaleEvent(record, true)(order);
  expect(record).toHaveBeenCalledExactlyOnceWith(order);
  expect(fetch).not.toHaveBeenCalled();
  resolve();
  await completed;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body).event).toBe('demo_sale_completed');
  expect(record.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
});

it('propagates the same recording error without sending an event', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const error = new Error('record failed');
  const record = vi.fn().mockRejectedValue(error);
  await expect(withDemoSaleEvent(record, true)({ id: 'sale' })).rejects.toBe(error);
  expect(fetch).not.toHaveBeenCalled();
});

it('still records when analytics is disabled', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const record = vi.fn();
  const order = { id: 'sale' };
  await withDemoSaleEvent(record, false)(order);
  expect(record).toHaveBeenCalledExactlyOnceWith(order);
  expect(fetch).not.toHaveBeenCalled();
});
