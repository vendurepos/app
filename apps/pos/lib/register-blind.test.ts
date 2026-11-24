import { afterEach, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { blindClosureText, blindFrom, registerBlind } from './register-blind';

afterEach(() => vi.unstubAllGlobals());
const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const answer = (permissions: string[], activeId = '2') =>
  ({ data: { me: { channels: [{ id: '1', permissions: ['ApproveTallyPosVariance'] }, { id: '2', permissions }] }, activeChannel: { id: activeId } } });
const refused = { data: { me: null, activeChannel: { id: '2' } }, errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] };

it('unblinds only permissions that hold the approve permission; unknown permissions count blind', () => {
  expect(blindFrom(['ReadOrder', 'ApproveTallyPosVariance'])).toBe(false);
  expect(blindFrom(['ReadOrder'])).toBe(true);
  expect(blindFrom([])).toBe(true);
  expect(blindFrom(undefined)).toBe(true);
});

it("reads the approver from /tally/v1/info's permissions, and counts blind without it", async () => {
  const fetch = vi.fn(async () => json({ permissions: ['TallyPosSell', 'ApproveTallyPosVariance'] }));
  vi.stubGlobal('fetch', fetch);
  expect(await registerBlind(context)).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://store.test/tally/v1/info');
  // A key till: /info answers its role's permissions, and Admin me is never asked.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ permissions: ['TallyPosSell'] })).mockResolvedValue(json(answer(['ApproveTallyPosVariance']))));
  expect(await registerBlind(context)).toBe(true);
});

it("on a plugin older than #487 reads the approver from Admin me's active channel, and counts blind when me is refused", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json({ contracts: {} })).mockResolvedValueOnce(json(answer(['ReadOrder', 'ApproveTallyPosVariance'])));
  vi.stubGlobal('fetch', fetch);
  expect(await registerBlind(context)).toBe(false);
  const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
  expect(url).toBe('https://store.test/admin-api');
  expect(JSON.parse(init.body as string).query).toContain('TillPermissions');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ contracts: {} })).mockResolvedValueOnce(json(answer(['ReadOrder'], '1'))));
  expect(await registerBlind(context)).toBe(false);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ contracts: {} })).mockResolvedValueOnce(json(answer(['ReadOrder']))));
  expect(await registerBlind(context)).toBe(true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ contracts: {} })).mockResolvedValueOnce(json(refused)));
  expect(await registerBlind(context)).toBe(true);
});

it('fails closed when /info answers 500 or the fetch fails, and Admin me fails too', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ permissions: ['ApproveTallyPosVariance'], ...answer(['ApproveTallyPosVariance']) }, 500)));
  expect(await registerBlind(context)).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  expect(await registerBlind(context)).toBe(true);
});

it('shows a blind cashier the cash they counted and nothing expected', () => {
  const text = blindClosureText(11904, 'EUR');
  expect(text).toBe('Cash counted €119.04 · sent for review');
  expect(text).not.toMatch(/Expected|variance/i);
});
