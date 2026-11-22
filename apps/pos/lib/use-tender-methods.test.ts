// @vitest-environment happy-dom
import type { PaymentMethodDescriptor, ServerCapabilities } from '@tallyui/core';
import { act, createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_INFO } from './demo/store';
import { defaultStore, sessionContext, sessionKey, type Session } from './session';
import { TENDER_METHODS_KEY, useTenderMethods } from './use-tender-methods';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session: Session = {
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'test-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};
const caps = (orderCreate: number): ServerCapabilities => ({ orderCreate, register: 1 });
const LISTED = DEMO_INFO.paymentMethods;
const STORED = `${TENDER_METHODS_KEY}:${sessionKey(session)}`;
const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

const fetchMock = vi.fn<typeof fetch>();
// Every value the hook returned, one per render.
let results: (PaymentMethodDescriptor[] | undefined)[];
// A real React root, so the hook's effects and memo run as in the app.
let root: { render(node: unknown): void; unmount(): void } | undefined;

function Probe({ capabilities }: { capabilities?: ServerCapabilities }) {
  results.push(useTenderMethods(session, capabilities));
  return null;
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(capabilities?: ServerCapabilities) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe, { capabilities })));
  await settle();
}
function unmount() {
  act(() => root?.unmount());
  root = undefined;
}
const last = () => results.at(-1);
const ids = () => last()?.map((method) => method.id);

beforeEach(() => {
  results = [];
  defaultStore().removeItem(STORED);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('useTenderMethods', () => {
  it("reads the session's /tally/v1/info and keeps the raw list in device storage", async () => {
    fetchMock.mockImplementation(() => answer(DEMO_INFO));
    await render(caps(10));
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1/tally/v1/info', expect.objectContaining({ headers: sessionContext(session).headers }));
    expect(ids()).toEqual(['cash', 'card-terminal', 'voucher']);
    expect(JSON.parse(defaultStore().getItem(STORED)!)).toEqual(LISTED);
  });

  it.each([
    ['fails', offline], ['is refused', () => answer({}, 403)], ['has no paymentMethods array', () => answer({ paymentMethods: 'none' })],
  ])('(v) keeps the first list when a second read %s', async (_, second) => {
    fetchMock.mockImplementationOnce(() => answer(DEMO_INFO)).mockImplementation(second);
    await render(caps(10));
    const first = last();
    expect(first).toHaveLength(3);
    await render(caps(10));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(last()).toBe(first);
  });

  it('(v2) gives the same array for an identical re-read and a new one when the list changes', async () => {
    fetchMock.mockImplementation(() => answer(DEMO_INFO));
    await render(caps(10));
    const first = last();
    await render(caps(10));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(last()).toBe(first);
    fetchMock.mockImplementation(() => answer({ paymentMethods: LISTED.slice(0, 2) }));
    await render(caps(10));
    expect(last()).not.toBe(first);
    expect(ids()).toEqual(['cash', 'card-terminal']);
  });

  it('(w) a fresh mount with the device offline returns the stored list', async () => {
    fetchMock.mockImplementation(() => answer(DEMO_INFO));
    await render(caps(10));
    unmount();
    results = [];
    fetchMock.mockImplementation(offline);
    await render(caps(10));
    expect(results[0]?.map((method) => method.id)).toEqual(['cash', 'card-terminal', 'voucher']);
    expect(ids()).toEqual(['cash', 'card-terminal', 'voucher']);
  });

  it('(w2) a list stored under order.create 10, mounted at 7, gives the default tiles', async () => {
    fetchMock.mockImplementation(() => answer(DEMO_INFO));
    await render(caps(10));
    unmount();
    fetchMock.mockImplementation(offline);
    await render(caps(7));
    expect(last()).toBeUndefined();
    await render(caps(10));
    expect(ids()).toEqual(['cash', 'card-terminal', 'voucher']);
  });

  it('(w3) an empty paymentMethods clears the stored list, so a later offline mount gives the default tiles', async () => {
    fetchMock.mockImplementationOnce(() => answer(DEMO_INFO)).mockImplementation(() => answer({ paymentMethods: [] }));
    await render(caps(10));
    await render(caps(10));
    expect(last()).toBeUndefined();
    unmount();
    fetchMock.mockImplementation(offline);
    await render(caps(10));
    expect(last()).toBeUndefined();
  });
});
