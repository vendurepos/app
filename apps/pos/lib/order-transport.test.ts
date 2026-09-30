import { afterEach, expect, it, vi } from 'vitest';
import { orderTransport } from './order-transport';
import type { Session } from './session';

const session: Session = {
  url: 'http://127.0.0.1:3200/', email: 'cashier@example.com', token: 'test-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};
const command = { id: 'command-1', type: 'order.create', version: 4 } as never;

afterEach(() => { vi.unstubAllGlobals(); });

/** Sends one command through the session's transport and returns the request the fake fetch saw. */
async function sentRequest(signedIn: Session) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await orderTransport(signedIn).send([command]);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  return { url, method: init.method, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
}

it("posts the commands to the store's /tally/v1/commands with the session's bearer token", async () => {
  const request = await sentRequest(session);
  expect(request).toMatchObject({ url: 'http://127.0.0.1:3200/tally/v1/commands', method: 'POST', body: { commands: [command] } });
  expect(request.headers).toMatchObject({ 'X-Tally-Protocol': expect.any(String), Authorization: 'Bearer test-token' });
  expect(request.headers).not.toHaveProperty('vendure-token');
});

it("adds the channel's vendure-token when the session has one", async () => {
  const request = await sentRequest({ ...session, channelToken: 'channel-token' });
  expect(request.headers).toMatchObject({ Authorization: 'Bearer test-token', 'vendure-token': 'channel-token' });
});

it('removes an unsupported order.create version below the net-discount minimum', async () => {
  const result = { id: 'command-1', status: 'rejected', error: {
    code: 'unsupported_version', message: 'Too old', data: { orderCreate: 3, other: 'x' },
  } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [result] }), { status: 200 })));

  expect(await orderTransport(session).send([command])).toEqual({ kind: 'results', results: [{
    id: 'command-1', status: 'rejected', error: {
      code: 'unsupported_version', message: 'Too old', data: { other: 'x' },
    },
  }] });
});

it.each([4, 5])('keeps an advertised order.create version of %i', async (version) => {
  const result = { id: 'command-1', status: 'rejected', error: {
    code: 'unsupported_version', message: 'Unsupported', data: { orderCreate: version },
  } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [result] }), { status: 200 })));

  expect(await orderTransport(session).send([command])).toEqual({ kind: 'results', results: [result] });
});

it('keeps applied results and other rejection codes unchanged', async () => {
  const results = [
    { id: 'command-1', status: 'applied', error: { code: 'unsupported_version', message: 'Applied', data: { orderCreate: 1 } } },
    { id: 'command-2', status: 'rejected', error: { code: 'invalid_payload', message: 'Invalid', data: { orderCreate: 1 } } },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results }), { status: 200 })));

  expect(await orderTransport(session).send([command])).toEqual({ kind: 'results', results });
});
