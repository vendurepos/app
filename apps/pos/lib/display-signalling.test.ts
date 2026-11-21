import { DisplaySignallingError } from '@tallyui/core';
import type { DisplaySignallingContext, SyncContext } from '@tallyui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDisplaySignalling } from './display-signalling';

const BASE = 'https://store.test/shop';
const SESSION = { Authorization: 'Bearer session', 'vendure-token': 'channel-a' };
const JSON_TYPE = { 'Content-Type': 'application/json' };
const SIGNAL = { type: 'offer' as const, payload: 'sdp' };

type Call = { source: 'global' | 'display'; url: string; init: RequestInit };
let calls: Call[];
let reply: { status: number; text: string };
let controller: AbortController;
let ctx: SyncContext;
let dctx: DisplaySignallingContext;

/** A fake `fetch` that records each call and answers with `reply`. */
const recorder = (source: Call['source']) => vi.fn(async (url: string, init: RequestInit) => {
  calls.push({ source, url, init });
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => reply.text } as Response;
});
const answer = (status: number, body?: unknown) => { reply = { status, text: body === undefined ? '' : JSON.stringify(body) }; };

beforeEach(() => {
  calls = [];
  answer(204);
  controller = new AbortController();
  ctx = { connectorId: 'vendure', baseUrl: BASE, headers: { ...SESSION }, signal: controller.signal };
  vi.stubGlobal('fetch', recorder('global'));
  dctx = { baseUrl: BASE, fetch: recorder('display') as unknown as typeof fetch };
});
afterEach(() => { vi.unstubAllGlobals(); });

const s = createDisplaySignalling();
const t = { deviceId: 'till-display-1', deviceKey: 'till-key-1' };

type Side = 'register' | 'till' | 'display' | 'token';
type Row = [name: string, run: () => Promise<unknown>, method: string, path: string, side: Side, body?: unknown];
const rows: Row[] = [
  ['registerDevice', () => s.registerDevice(ctx, t.deviceId), 'POST', 'displays/device', 'register'],
  ['mint', () => s.mint(ctx, t), 'POST', 'displays/codes', 'till'],
  ['pending', () => s.pending(ctx, t), 'GET', 'displays/pending', 'till'],
  ['confirm', () => s.confirm(ctx, t, 'c1'), 'POST', 'displays/pending/c1/confirm', 'till'],
  ['decline', () => s.decline(ctx, t, 'c1'), 'POST', 'displays/pending/c1/decline', 'till'],
  ['list', () => s.list(ctx, t), 'GET', 'displays', 'till'],
  ['forget', () => s.forget(ctx, t, 'd1'), 'DELETE', 'displays/d1', 'till'],
  ['sendSignal', () => s.sendSignal(ctx, t, 'd1', SIGNAL), 'POST', 'displays/d1/signals', 'till', SIGNAL],
  ['receiveSignals', () => s.receiveSignals(ctx, t), 'GET', 'displays/signals', 'till'],
  ['postSnapshot', () => s.postSnapshot(ctx, t, 'd1', { total: 5 }), 'PUT', 'displays/d1/snapshot', 'till', { snapshot: { total: 5 } }],
  ['claim', () => s.claim(dctx, { code: '123456', displayName: 'Front' }), 'POST', 'display/claim', 'display', { code: '123456', displayName: 'Front' }],
  ['collect', () => s.collect(dctx, 'secret'), 'POST', 'display/collect', 'display', { claimSecret: 'secret' }],
  ['displaySendSignal', () => s.displaySendSignal(dctx, 'tok', SIGNAL), 'POST', 'display/signals', 'token', SIGNAL],
  ['displayReceiveSignals', () => s.displayReceiveSignals(dctx, 'tok'), 'GET', 'display/signals', 'token'],
  ['readSnapshot', () => s.readSnapshot(dctx, 'tok'), 'GET', 'display/snapshot', 'token'],
];

describe('requests', () => {
  it('covers every method of the seam', () => {
    expect(rows.map(([name]) => name).sort()).toEqual(Object.keys(s).sort());
  });

  it.each(rows)('%s: method, URL, headers and body', async (_name, run, method, path, side, body) => {
    answer(200, { items: [], snapshot: null, deviceKey: 'issued-key' });
    await run();
    expect(calls).toHaveLength(1);
    const [{ source, url, init }] = calls;
    expect(init.method).toBe(method);
    expect(url).toBe(`${BASE}/tally/v1/${path}`);
    // Every till route sends the device's key beside its id; registerDevice, which issues the key, sends the id alone.
    const own = side === 'till' ? { ...SESSION, 'X-Tally-Device-Id': t.deviceId, 'X-Tally-Device-Key': t.deviceKey }
      : side === 'register' ? { ...SESSION, 'X-Tally-Device-Id': t.deviceId }
        : side === 'token' ? { 'X-Tally-Display-Token': 'tok' } : {};
    expect(init.headers).toEqual(body === undefined ? own : { ...own, ...JSON_TYPE });
    expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
    // Till calls use the global fetch and the session's signal; display calls use the display's own fetch.
    const tillSide = side === 'till' || side === 'register';
    expect(source).toBe(tillSide ? 'global' : 'display');
    expect(init.signal).toBe(tillSide ? controller.signal : undefined);
  });

  it('sends the key of the device it is given, never another', async () => {
    answer(200, { items: [] });
    await s.list(ctx, { deviceId: 'till-display-2', deviceKey: 'till-key-2' });
    expect(calls[0].init.headers).toMatchObject({ 'X-Tally-Device-Id': 'till-display-2', 'X-Tally-Device-Key': 'till-key-2' });
  });
});

describe('responses', () => {
  it('unwraps the lists to their items', async () => {
    const items = [{ displayId: 'd1' }];
    answer(200, { items });
    expect(await s.pending(ctx, t)).toEqual(items);
    expect(await s.list(ctx, t)).toEqual(items);
    expect(await s.receiveSignals(ctx, t)).toEqual(items);
    expect(await s.displayReceiveSignals(dctx, 'tok')).toEqual(items);
  });

  it('unwraps the snapshot, passing null through', async () => {
    answer(200, { snapshot: { total: 5 } });
    expect(await s.readSnapshot(dctx, 'tok')).toEqual({ total: 5 });
    answer(200, { snapshot: null });
    expect(await s.readSnapshot(dctx, 'tok')).toBeNull();
  });

  it('returns the key registerDevice is issued', async () => {
    answer(200, { deviceKey: 'issued-key' });
    expect(await s.registerDevice(ctx, t.deviceId)).toEqual({ deviceKey: 'issued-key' });
  });

  it('returns mint, claim and collect as answered', async () => {
    answer(200, { code: '123456', expiresAt: 'later' });
    expect(await s.mint(ctx, t)).toEqual({ code: '123456', expiresAt: 'later' });
    answer(200, { claimSecret: 'secret', checkCode: '1234' });
    expect(await s.claim(dctx, { code: '123456', displayName: 'Front' })).toEqual({ claimSecret: 'secret', checkCode: '1234' });
    answer(200, { status: 'pending', checkCode: '1234' });
    expect(await s.collect(dctx, 'secret')).toEqual({ status: 'pending', checkCode: '1234' });
  });

  it('resolves the writes to undefined, with or without a body', async () => {
    answer(204);
    expect(await s.confirm(ctx, t, 'c1')).toBeUndefined();
    expect(await s.decline(ctx, t, 'c1')).toBeUndefined();
    expect(await s.forget(ctx, t, 'd1')).toBeUndefined();
    answer(200, { ok: true });
    expect(await s.sendSignal(ctx, t, 'd1', SIGNAL)).toBeUndefined();
    expect(await s.postSnapshot(ctx, t, 'd1', {})).toBeUndefined();
    expect(await s.displaySendSignal(dctx, 'tok', SIGNAL)).toBeUndefined();
  });
});

describe('errors', () => {
  const refusal = async (run: () => Promise<unknown>) => {
    const error = await run().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(DisplaySignallingError);
    return error as DisplaySignallingError;
  };

  it('takes a seam code and message from the body', async () => {
    answer(403, { code: 'forbidden', message: 'm' });
    const error = await refusal(() => s.list(ctx, t));
    expect([error.code, error.message]).toEqual(['forbidden', 'm']);
    answer(403, { code: 'token_refused', message: 'gone' });
    expect((await refusal(() => s.readSnapshot(dctx, 'tok'))).code).toBe('token_refused');
  });

  it('gives device_refused for a refused device key', async () => {
    answer(403, { code: 'device_refused', message: 'refused' });
    const error = await refusal(() => s.mint(ctx, t));
    expect([error.code, error.message]).toEqual(['device_refused', 'refused']);
    expect((await refusal(() => s.registerDevice(ctx, t.deviceId))).code).toBe('device_refused');
  });

  it('gives server when registerDevice is answered with no key', async () => {
    answer(200, {});
    expect((await refusal(() => s.registerDevice(ctx, t.deviceId))).code).toBe('server');
    answer(204);
    expect((await refusal(() => s.registerDevice(ctx, t.deviceId))).code).toBe('server');
  });

  it('gives server for a code the seam does not name', async () => {
    answer(400, { code: 'bogus' });
    expect((await refusal(() => s.mint(ctx, t))).code).toBe('server');
  });

  it('gives server for a body that is not JSON', async () => {
    reply = { status: 502, text: '<html>Bad Gateway</html>' };
    expect((await refusal(() => s.list(ctx, t))).code).toBe('server');
  });

  it('gives network when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await refusal(() => s.list(ctx, t))).code).toBe('network');
  });

  it('rethrows an abort unchanged', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort; }));
    await expect(s.list(ctx, t)).rejects.toBe(abort);
    dctx.fetch = vi.fn(async () => { throw abort; }) as unknown as typeof fetch;
    await expect(s.readSnapshot(dctx, 'tok')).rejects.toBe(abort);
  });
});

it('encodes ids in the path', async () => {
  await s.forget(ctx, t, 'a/b');
  expect(calls[0].url).toBe(`${BASE}/tally/v1/displays/a%2Fb`);
});
