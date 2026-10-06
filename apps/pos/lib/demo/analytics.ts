import { DEMO_MODE } from './mode';

/** Sends anonymous demo events to PostHog at ph.wcpos.com with credentials: 'omit' and an in-memory id per page load.
 * Writes no cookie or storage, so no consent banner is needed, matching the marketing sites' recorder
 * (front desk ruling, 2026-10-05). */
export type DemoEvent = 'demo_opened' | 'demo_signed_in' | 'demo_sale_completed' | 'demo_reset';
// Public PostHog project key shared with vendurepos.com's pageview recorder.
const API_KEY = 'phc_BhTJzZ7fXMqcD4MiaUJQsQqPkEpu94yoSAthXFBWemvd';
// Only the public demo host records events; also identifies the site in each capture.
export const DEMO_HOST = 'demo.vendurepos.com';
export const DEMO_CAPTURE_URL = 'https://ph.wcpos.com/e/';
const visitId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

export function demoAnalyticsEnabled(demo: boolean = DEMO_MODE, hostname: string | undefined = globalThis.location?.hostname): boolean {
  return demo && hostname === DEMO_HOST;
}

export function trackDemoEvent(event: DemoEvent, enabled: boolean = demoAnalyticsEnabled()): void {
  if (!enabled) return;
  try {
    void fetch(DEMO_CAPTURE_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', keepalive: true,
      body: JSON.stringify({
        api_key: API_KEY, event, distinct_id: visitId,
        properties: { site: DEMO_HOST, $process_person_profile: false },
      }),
    }).catch(() => {});
  } catch { /* A missing or throwing fetch must not interrupt the demo. */ }
}

export function withDemoSaleEvent<T>(record: (order: T) => Promise<void> | void, enabled?: boolean): (order: T) => Promise<void> {
  return async (order) => {
    await record(order);
    trackDemoEvent('demo_sale_completed', enabled);
  };
}
