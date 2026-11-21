import { afterEach, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { blindClosureText, blindFromPermissions, registerBlind } from './register-blind';

afterEach(() => vi.unstubAllGlobals());
const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
const answer = (permissions: string[], activeId = '2') =>
  ({ data: { me: { channels: [{ id: '1', permissions: ['ApproveTallyPosVariance'] }, { id: '2', permissions }] }, activeChannel: { id: activeId } } });

it('unblinds only the active channel that holds the approve permission', () => {
  expect(blindFromPermissions(answer(['ReadOrder', 'ApproveTallyPosVariance']))).toBe(false);
  expect(blindFromPermissions(answer(['ReadOrder']))).toBe(true);
  expect(blindFromPermissions(answer(['ReadOrder'], '1'))).toBe(false);
  expect(blindFromPermissions({ data: { me: { channels: [{ id: '1', permissions: ['ApproveTallyPosVariance'] }] }, activeChannel: { id: '2' } } })).toBe(true);
});

it('counts blind on GraphQL errors and missing data', () => {
  expect(blindFromPermissions({ ...answer(['ApproveTallyPosVariance']), errors: [{ message: 'Forbidden' }] })).toBe(true);
  expect(blindFromPermissions({})).toBe(true);
  expect(blindFromPermissions(null)).toBe(true);
});

it('reads the approver unblinded and fails closed on a 500 or a failed fetch', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(answer(['ApproveTallyPosVariance'])), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  expect(await registerBlind(context)).toBe(false);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://store.test/admin-api');
  expect(JSON.parse(init.body as string).query).toContain('RegisterPermissions');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer(['ApproveTallyPosVariance'])), { status: 500 })));
  expect(await registerBlind(context)).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  expect(await registerBlind(context)).toBe(true);
});

it('shows a blind cashier the cash they counted and nothing expected', () => {
  const text = blindClosureText(11904, 'EUR');
  expect(text).toBe('Cash counted €119.04 · sent for review');
  expect(text).not.toMatch(/Expected|variance/i);
});
