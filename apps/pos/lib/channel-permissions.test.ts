import { afterEach, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { channelPermissions } from './channel-permissions';

afterEach(() => vi.unstubAllGlobals());
const signal = new AbortController().signal;
const context: SyncContext = { connectorId: 'vendure', baseUrl: 'https://store.test', headers: { 'vendure-api-key': 'key', 'vendure-token': 'channel' }, signal };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const me = (permissions: unknown, activeId = '2') =>
  json({ data: { me: { channels: [{ id: '1', permissions: ['ApproveTallyPosVariance'] }, { id: '2', permissions }] }, activeChannel: { id: activeId } } });
const refused = () => json({ data: { me: null, activeChannel: { id: '2' } }, errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] });

it("reads /tally/v1/info's permissions with the till's headers, and asks Admin me nothing more", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ contracts: {}, permissions: ['TallyPosSell', 'CreateCustomer'] }));
  vi.stubGlobal('fetch', fetch);
  expect(await channelPermissions(context)).toEqual(['TallyPosSell', 'CreateCustomer']);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://store.test/tally/v1/info');
  expect(init).toEqual({ headers: context.headers, signal });
});

it('falls back to the active channel of Admin me on a plugin older than #487', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ contracts: {} })).mockResolvedValueOnce(me(['ReadOrder', 'ApproveTallyPosVariance']));
  vi.stubGlobal('fetch', fetch);
  expect(await channelPermissions(context)).toEqual(['ReadOrder', 'ApproveTallyPosVariance']);
  const [url, init] = fetch.mock.calls[1];
  expect(url).toBe('https://store.test/admin-api');
  expect(init?.method).toBe('POST');
  expect(init?.headers).toEqual({ 'Content-Type': 'application/json', ...context.headers });
  expect(JSON.parse(init?.body as string)).toEqual({ query: 'query TillPermissions { me { channels { id permissions } } activeChannel { id } }' });
});

it("never reads another channel's permissions: no entry for the active channel is []", async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(me(['ReadOrder'], '3')));
  expect(await channelPermissions(context)).toEqual([]);
});

it.each([
  ['a string', 'ApproveTallyPosVariance'], ['an object', { ApproveTallyPosVariance: true }], ['a list with a non-string', ['ApproveTallyPosVariance', 1]], ['null', null],
])('treats /info permissions that are %s as absent and falls back', async (_kind, permissions) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ permissions })).mockResolvedValueOnce(me(['ReadOrder'])));
  expect(await channelPermissions(context)).toEqual(['ReadOrder']);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ permissions })).mockResolvedValueOnce(refused()));
  expect(await channelPermissions(context)).toBeUndefined();
});

it('is undefined when /info has no permissions and Admin me is refused, as for a device-key till on an older plugin', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ contracts: {} })).mockResolvedValueOnce(refused()));
  expect(await channelPermissions(context)).toBeUndefined();
});

it('is undefined when neither /info nor Admin me answers', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ permissions: ['ApproveTallyPosVariance'] }, 500)).mockResolvedValueOnce(json({ data: { me: { channels: [{ id: '2', permissions: ['ApproveTallyPosVariance'] }] }, activeChannel: { id: '2' } } }, 500)));
  expect(await channelPermissions(context)).toBeUndefined();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  expect(await channelPermissions(context)).toBeUndefined();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not json')).mockResolvedValueOnce(json({ data: { me: { channels: [{ id: '2', permissions: 'ReadOrder' }] }, activeChannel: { id: '2' } } })));
  expect(await channelPermissions(context)).toBeUndefined();
});

it('falls back to Admin me when /info throws', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(me(['CreateCustomer'])));
  expect(await channelPermissions(context)).toEqual(['CreateCustomer']);
});
