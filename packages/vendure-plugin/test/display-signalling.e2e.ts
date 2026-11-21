import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Global } from '@nestjs/common';
import { PluginCommonModule, TransactionalConnection, VendurePlugin } from '@vendure/core';
import { DisplaySignallingError } from '@tallyui/core';
import type { DisplaySignalling, DisplaySignallingContext, DisplaySignallingErrorCode, SyncContext, TillDevice } from '@tallyui/core';
import { displaySignallingContract } from '@tallyui/core/server';
import type { DisplaySignallingHarness } from '@tallyui/core/server';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POS_TILL_PERMISSIONS, TallyPosPlugin } from '../src';
import { TALLY_DISPLAY_CLOCK } from '../src/service/display-signalling.service';
import { bootstrapSecondInstance, createPluginTestEnvironment } from './env';

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const TABLES = ['tally_display_signal', 'tally_display_snapshot', 'tally_display', 'tally_display_pending', 'tally_display_code', 'tally_display_claim_window',
  'tally_display_device'];
const ICE = [{ urls: 'stun:stun.example.test:3478' }];

// V6: the one clock behind every expiry and window, moved by `advance`. Global, so both instances' services take it.
let offset = 0;
@Global()
@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [{ provide: TALLY_DISPLAY_CLOCK, useValue: () => Date.now() + offset }],
  exports: [TALLY_DISPLAY_CLOCK],
})
class DisplayClockPlugin {}

/** One call of the routes; a refusal becomes the seam's error with the body's code and message. */
async function call<T>(baseUrl: string, doFetch: typeof fetch, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const response = await doFetch(`${baseUrl}/tally/v1/${path}`, {
    method, headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new DisplaySignallingError((parsed?.code ?? 'server') as DisplaySignallingErrorCode, parsed?.message);
  return parsed as T;
}

/** A test-only client of the routes, as lane 9.8b's connector will be. */
const signalling: DisplaySignalling = (() => {
  const till = (ctx: SyncContext, device: TillDevice) => <T>(method: string, path: string, body?: unknown) =>
    call<T>(ctx.baseUrl, fetch, method, path, { ...ctx.headers, 'X-Tally-Device-Id': device.deviceId, 'X-Tally-Device-Key': device.deviceKey }, body);
  const display = (d: DisplaySignallingContext, token?: string) => <T>(method: string, path: string, body?: unknown) =>
    call<T>(d.baseUrl, d.fetch ?? fetch, method, path, token === undefined ? {} : { 'X-Tally-Display-Token': token }, body);
  const id = encodeURIComponent;
  type Items<T> = { items: T[] };
  return {
    registerDevice: (ctx, deviceId) => call(ctx.baseUrl, fetch, 'POST', 'displays/device', { ...ctx.headers, 'X-Tally-Device-Id': deviceId }),
    mint: (ctx, device) => till(ctx, device)('POST', 'displays/codes'),
    pending: async (ctx, device) => (await till(ctx, device)<Items<never>>('GET', 'displays/pending')).items,
    confirm: async (ctx, device, claimId) => { await till(ctx, device)('POST', `displays/pending/${id(claimId)}/confirm`); },
    decline: async (ctx, device, claimId) => { await till(ctx, device)('POST', `displays/pending/${id(claimId)}/decline`); },
    list: async (ctx, device) => (await till(ctx, device)<Items<never>>('GET', 'displays')).items,
    forget: async (ctx, device, displayId) => { await till(ctx, device)('DELETE', `displays/${id(displayId)}`); },
    sendSignal: async (ctx, device, displayId, message) => { await till(ctx, device)('POST', `displays/${id(displayId)}/signals`, message); },
    receiveSignals: async (ctx, device) => (await till(ctx, device)<Items<never>>('GET', 'displays/signals')).items,
    postSnapshot: async (ctx, device, displayId, body) => { await till(ctx, device)('PUT', `displays/${id(displayId)}/snapshot`, { snapshot: body }); },
    claim: (d, request) => display(d)('POST', 'display/claim', request),
    collect: (d, claimSecret) => display(d)('POST', 'display/collect', { claimSecret }),
    displaySendSignal: async (d, token, message) => { await display(d, token)('POST', 'display/signals', message); },
    displayReceiveSignals: async (d, token) => (await display(d, token)<Items<never>>('GET', 'display/signals')).items,
    readSnapshot: async (d, token) => (await display(d, token)<{ snapshot: unknown }>('GET', 'display/snapshot')).snapshot,
  };
})();

describe('customer display signalling (TallyUI ADR-085 U7)', () => {
  const environment = createPluginTestEnvironment({ apiOptions: { trustProxy: true } }, [TallyPosPlugin, DisplayClockPlugin]);
  const { server, adminClient } = environment;
  let connection: TransactionalConnection;
  let second: Awaited<ReturnType<typeof bootstrapSecondInstance>>;
  let base: string;
  const channels: Record<'a' | 'b', { id: string; token: string }> = { a: { id: '', token: '' }, b: { id: '', token: '' } };
  const sessions = new Map<string, Promise<Record<string, string>>>();

  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    // TestServer does not apply apiOptions.trustProxy (bootstrap() does, for the second instance): set it as a merchant would.
    server.app.getHttpAdapter().getInstance().set('trust proxy', true);
    base = await server.app.getUrl();
    const { zones, activeChannel } = await adminClient.query<{
      zones: { items: Array<{ id: string; name: string }> }; activeChannel: { id: string; token: string };
    }>(parse('query { zones { items { id name } } activeChannel { id token } }'));
    channels.a = activeChannel;
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id token } } }`), { input: {
      code: 'display-b', token: 'display-b-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    channels.b = createChannel;
    // (d) The second instance takes the init option; the harness server booted without it.
    TallyPosPlugin.init({ customerDisplay: { iceServers: ICE } });
    // The second instance defaults to REPEATABLE READ, as a merchant database could, so (h) claims across both defaults.
    second = await bootstrapSecondInstance(connection.rawConnection.options.database as string, { apiOptions: { trustProxy: true },
      dbConnectionOptions: { extra: { options: '-c default_transaction_isolation=repeatable\\ read' } } }, [TallyPosPlugin, DisplayClockPlugin]);
    // Proof the default took, outside any transaction: otherwise (h) would pass on READ COMMITTED alone.
    expect((await second.app.get(TransactionalConnection).rawConnection.query('SHOW default_transaction_isolation'))[0])
      .toEqual({ default_transaction_isolation: 'repeatable read' });
  });
  afterAll(async () => {
    TallyPosPlugin.init({});
    await second?.app.close();
    await server.destroy();
  });

  /** A logged-in Administrator whose role, in one channel, holds `permissions`; the session and channel headers. */
  function sessionWith(identifier: string, permissions: string[], channel: 'a' | 'b'): Promise<Record<string, string>> {
    const key = `${identifier}|${permissions.join()}|${channel}`;
    if (!sessions.has(key)) sessions.set(key, (async () => {
      const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
        createRole(input: $input) { id } }`), { input: { code: `display-${randomUUID()}`, description: key, permissions, channelIds: [channels[channel].id] } });
      await adminClient.query(parse('mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }'),
        { input: { firstName: 'Till', lastName: identifier, emailAddress: identifier, password: 'till-password', roleIds: [createRole.id] } });
      const response = await fetch(`${base}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        query: `mutation { login(username: "${identifier}", password: "till-password") { ... on CurrentUser { id } } }` }) });
      expect((await response.json()).data.login).toMatchObject({ id: expect.any(String) });
      return { Authorization: `Bearer ${response.headers.get('vendure-auth-token')}`, 'vendure-token': channels[channel].token };
    })());
    return sessions.get(key)!;
  }
  // An identifier per role, since one Administrator's email holds one set of roles.
  const till = async (cashierId: string, permissions: string[], channel: 'a' | 'b' = 'a', at = base): Promise<SyncContext> =>
    ({ connectorId: 'vendurepos-display-test', baseUrl: at, headers: await sessionWith(cashierId, permissions, channel) });
  const pairTill = (cashierId: string, channel: 'a' | 'b' = 'a', at = base) =>
    till(channel === 'a' ? cashierId : `${cashierId}-${channel}`, ['TallyPosPairDisplay'], channel, at);
  /** A display whose requests come from `source`, through the server's `trust proxy`. */
  const display = (source: string, at = base): DisplaySignallingContext => ({
    baseUrl: at, fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'X-Forwarded-For': source } }),
  });
  const count = async (table: string, where = 'true') =>
    Number((await connection.rawConnection.query(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`))[0].n);
  const refused = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string }) => error.code);
  /** Registers `deviceId` with `ctx`: the till's credential for its other calls. */
  const register = async (ctx: SyncContext, deviceId: string): Promise<TillDevice> =>
    ({ deviceId, deviceKey: (await signalling.registerDevice(ctx, deviceId)).deviceKey });
  const mintAs = async (ctx: SyncContext, deviceId: string) => signalling.mint(ctx, await register(ctx, deviceId));
  /** A display paired with `ctx` up to the confirm, and its claim secret. */
  async function confirmed(ctx: SyncContext, device: TillDevice, d: DisplaySignallingContext) {
    const { code } = await signalling.mint(ctx, device);
    const claim = await signalling.claim(d, { code, displayName: 'Counter' });
    const entry = (await signalling.pending(ctx, device)).find(p => p.checkCode === claim.checkCode)!;
    await signalling.confirm(ctx, device, entry.claimId);
    return claim;
  }
  async function paired(ctx: SyncContext, device: TillDevice, d: DisplaySignallingContext) {
    const result = await signalling.collect(d, (await confirmed(ctx, device, d)).claimSecret);
    if (result.status !== 'paired') throw new Error('not paired');
    return result;
  }
  /** The raw status and body of one request to the routes, bypassing the client's own headers and shapes. */
  const answer = async (path: string, init: RequestInit) => {
    const response = await fetch(`${base}/tally/v1/${path}`, init);
    return [response.status, await response.json()];
  };
  const fresh = () => connection.rawConnection.query(`TRUNCATE ${TABLES.map(table => `"${table}"`).join(', ')}`);

  const make = async (): Promise<DisplaySignallingHarness> => {
    await fresh();
    return {
      signalling,
      till: ({ cashierId, canPair }) => till(cashierId, [canPair ? 'TallyPosPairDisplay' : 'TallyPosSell']),
      display: source => display(source),
      advance: async ms => { offset += ms; },
      storedText: async () => JSON.stringify(await Promise.all(TABLES.map(table =>
        connection.rawConnection.query(`SELECT row_to_json(t) AS row FROM "${table}" AS t`)))),
      storedCounts: async () => ({ codes: await count('tally_display_code'), pending: await count('tally_display_pending'),
        displays: await count('tally_display'), snapshots: await count('tally_display_snapshot'), devices: await count('tally_display_device') }),
      // As the migration leaves a till: a paired display with a token, and its device row with no key.
      seedLegacyDevice: async deviceId => {
        const token = randomBytes(16).toString('base64url'), displayId = randomBytes(16).toString('hex');
        const channelId = environment.decode(channels.a.id), now = new Date(Date.now() + offset);
        await connection.rawConnection.query(`INSERT INTO "tally_display" ("id", "channelId", "deviceId", "name", "cashierId", "confirmedAt", "tokenHash")
          VALUES ($1, $2, $3, 'Legacy', 'cashier-legacy', $4, $5)`, [displayId, channelId, deviceId, now, createHash('sha256').update(token).digest('hex')]);
        await connection.rawConnection.query('INSERT INTO "tally_display_device" ("channelId", "deviceId", "lastCallAt") VALUES ($1, $2, $3)',
          [channelId, deviceId, now]);
        return { displayId, token };
      },
      adoptionLog: async () => (await connection.rawConnection.query(`SELECT "deviceId", "adoptedBy" FROM "tally_display_device"
        WHERE "adoptedBy" IS NOT NULL ORDER BY "adoptedAt"`)).map((row: { deviceId: string; adoptedBy: string }) =>
        ({ deviceId: row.deviceId, cashierId: row.adoptedBy })),
    };
  };

  describe('the contract, unchanged', () => {
    for (const c of displaySignallingContract(make)) it(c.name, c.run);
  });

  it('(a) two instances racing one code: exactly one claim spends it', async () => {
    await fresh();
    const ctx = await pairTill('race-a');
    const device = await register(ctx, 'till-race');
    for (let round = 0; round < 5; round += 1) {
      const { code } = await signalling.mint(ctx, device);
      const results = await Promise.allSettled([base, second.url].map((at, i) =>
        signalling.claim(display(`192.0.2.${10 + round * 2 + i}`, at), { code, displayName: `Race ${i}` })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected').map(r => (r.reason as { code: string }).code)).toEqual(['claim_refused']);
    }
    expect(await count('tally_display_pending')).toBe(5);
  });

  it('(b) two instances racing one collect: exactly one token is issued', async () => {
    await fresh();
    const ctx = await pairTill('race-b');
    const device = await register(ctx, 'till-race');
    for (let round = 0; round < 5; round += 1) {
      const { claimSecret } = await confirmed(ctx, device, display('192.0.2.30'));
      const results = await Promise.allSettled([base, second.url].map(at => signalling.collect(display('192.0.2.30', at), claimSecret)));
      expect(results.map(r => r.status === 'fulfilled' ? r.value.status : (r.reason as { code: string }).code).sort())
        .toEqual(['collect_refused', 'paired']);
    }
    expect(await count('tally_display', '"tokenHash" IS NOT NULL AND "secretHash" IS NULL')).toBe(5);
  });

  it('(c) a display paired in channel B works with no channel or session; channel A cannot reach it', async () => {
    await fresh();
    const inB = await pairTill('channel', 'b');
    const inA = await pairTill('channel', 'a');
    const onB = await register(inB, 'till-shared'), onA = await register(inA, 'till-shared');
    // One device id in both channels, so only the channel keeps them apart.
    const d = display('192.0.2.40');
    const { displayId, token } = await paired(inB, onB, d);
    expect((await signalling.list(inB, onB)).map(r => r.displayId)).toEqual([displayId]);
    await signalling.sendSignal(inB, onB, displayId, { type: 'offer', payload: 'o1' });
    await signalling.postSnapshot(inB, onB, displayId, { seq: 1 });
    expect(await signalling.displayReceiveSignals(d, token)).toEqual([{ type: 'offer', payload: 'o1' }]);
    expect(await signalling.readSnapshot(d, token)).toEqual({ seq: 1 });
    await signalling.displaySendSignal(d, token, { type: 'answer', payload: 'a1' });

    expect(await signalling.list(inA, onA)).toEqual([]);
    expect(await signalling.receiveSignals(inA, onA)).toEqual([]);
    expect(await refused(signalling.forget(inA, onA, displayId))).toBe('not_found');
    expect(await refused(signalling.sendSignal(inA, onA, displayId, { type: 'ice', payload: 'x' }))).toBe('not_found');
    expect(await refused(signalling.postSnapshot(inA, onA, displayId, { seq: 2 }))).toBe('not_found');
    expect(await signalling.receiveSignals(inB, onB)).toEqual([{ type: 'answer', payload: 'a1', displayId }]);
    expect(await signalling.readSnapshot(d, token)).toEqual({ seq: 1 });
    expect(await count('tally_display')).toBe(1);
  });

  it('(d) /info advertises customerDisplay, with the init option\'s iceServers and without them when it is absent', async () => {
    const superAdmin = { Authorization: `Bearer ${adminClient.getAuthToken()}` };
    const info = async (at: string) => (await (await fetch(`${at}/tally/v1/info`, { headers: superAdmin })).json()).customerDisplay;
    expect(await info(base)).toEqual({ v: 1, snapshot: 1 });
    expect(await info(second.url)).toEqual({ v: 1, snapshot: 1, iceServers: ICE });
  });

  it('(e) TallyPosSell or CreateOrder without TallyPosPairDisplay cannot mint; the till preset holds it', async () => {
    await fresh();
    for (const permissions of [['TallyPosSell'], ['TallyPosSell', 'CreateOrder']]) {
      const ctx = await till(`seller-${permissions.length}`, permissions);
      const response = await fetch(`${base}/tally/v1/displays/codes`, { method: 'POST', headers: { ...ctx.headers, 'X-Tally-Device-Id': 'till-e' } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'forbidden', message: expect.any(String) });
    }
    expect(await count('tally_display_code')).toBe(0);
    expect(POS_TILL_PERMISSIONS).toContain('TallyPosPairDisplay');
  });

  it('(f) the store-wide cap refuses claims only: the till still mints and confirms, and the display collects', async () => {
    await fresh();
    const ctx = await pairTill('cap');
    const device = await register(ctx, 'till-cap');
    const d = display('192.0.2.50');
    const { code } = await signalling.mint(ctx, device);
    const claim = await signalling.claim(d, { code, displayName: 'Counter' });
    for (let i = 0; i < 100; i += 1) {
      expect(await refused(signalling.claim(display(`203.0.113.${Math.floor(i / 9) + 1}`), { code: '999999x', displayName: 'Guess' }))).toBe('claim_refused');
    }
    const fresher = await signalling.mint(ctx, device);
    expect(await refused(signalling.claim(display('192.0.2.51'), { code: fresher.code, displayName: 'Paused' }))).toBe('claim_refused');
    const [entry] = await signalling.pending(ctx, device);
    await signalling.confirm(ctx, device, entry.claimId);
    expect(await signalling.collect(d, claim.claimSecret)).toMatchObject({ status: 'paired' });
  });

  it('(g) pruning deletes the rows: pending, snapshot, both failure windows, and both inboxes of a display unseen for 30 days', async () => {
    await fresh();
    const ctx = await pairTill('prune');
    const device = await register(ctx, 'till-prune');
    const d = display('192.0.2.60');
    const { displayId, token } = await paired(ctx, device, d);
    await signalling.claim(display('192.0.2.61'), { code: (await signalling.mint(ctx, device)).code, displayName: 'Lapsing' });
    await signalling.postSnapshot(ctx, device, displayId, { seq: 1 });
    await refused(signalling.claim(display('192.0.2.62'), { code: 'no-such-code', displayName: 'Guess' }));
    expect([await count('tally_display_pending'), await count('tally_display_snapshot'), await count('tally_display_claim_window')]).toEqual([1, 1, 2]);

    offset += 61_000;
    await signalling.list(ctx, device);
    expect(await count('tally_display_snapshot')).toBe(0);
    expect(await count('tally_display_claim_window')).toBe(1);
    expect(await count('tally_display_claim_window', `"key" = 'store'`)).toBe(1);
    offset += 10 * MINUTE;
    await signalling.list(ctx, device);
    expect([await count('tally_display_pending'), await count('tally_display_claim_window')]).toEqual([0, 0]);

    await signalling.sendSignal(ctx, device, displayId, { type: 'offer', payload: 'o1' });
    await signalling.displaySendSignal(d, token, { type: 'answer', payload: 'a1' });
    expect([await count('tally_display_signal', '"toTill"'), await count('tally_display_signal', 'NOT "toTill"')]).toEqual([1, 1]);
    offset += 30 * DAY;
    await signalling.list(ctx, device);
    expect([await count('tally_display'), await count('tally_display_signal')]).toEqual([0, 0]);
  });

  it('(h) concurrent failed claims across both instances stop at the limit', async () => {
    await fresh();
    const { code } = await mintAs(await pairTill('limit-race'), 'till-limit');
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      refused(signalling.claim(display('192.0.2.70', i % 2 ? second.url : base), { code: '000000x', displayName: 'Guess' }))));
    expect(results).toEqual(Array(30).fill('claim_refused'));
    const failures = async (where: string) => (await connection.rawConnection.query(
      `SELECT "failures" FROM "tally_display_claim_window" WHERE ${where}`)).map((row: { failures: number }) => Number(row.failures));
    expect([await failures(`"key" LIKE 'source:%'`), await failures(`"key" = 'store'`)]).toEqual([[10], [10]]);
    expect(await refused(signalling.claim(display('192.0.2.70'), { code, displayName: 'Counter' }))).toBe('claim_refused');
    expect(await count('tally_display_code', 'NOT "spent"')).toBe(1);
  });

  it('(i) the public routes refuse bad input in the seam\'s shape', async () => {
    const json = { 'Content-Type': 'application/json' };
    const ctx = await pairTill('bad-input');
    const headers = { ...ctx.headers, 'X-Tally-Device-Id': 'till-i', 'X-Tally-Device-Key': (await register(ctx, 'till-i')).deviceKey };
    expect(await answer('displays/%00', { method: 'DELETE', headers })).toEqual([404, { code: 'not_found', message: expect.any(String) }]);
    expect(await answer('display/claim', { method: 'POST', headers: json, body: '{' }))
      .toEqual([400, { code: 'invalid_request', message: expect.any(String) }]);
    const big = JSON.stringify({ type: 'offer', payload: 'x'.repeat(450_000 - 29) }); // over the parser's 409 600 bytes
    expect(await answer('display/signals', { method: 'POST', headers: json, body: big }))
      .toEqual([413, { code: 'too_large', message: expect.any(String) }]);
  });

  it('(i2) the controller\'s own checks refuse a bad device header, bad fields and a missing display token, storing nothing', async () => {
    await fresh();
    const ctx = await pairTill('own-checks');
    const device = await register(ctx, 'till-i2');
    const { displayId } = await paired(ctx, device, display('192.0.2.110'));
    const stored = () => Promise.all(TABLES.map(table => count(table)));
    const before = await stored();
    const refusal = (status: number, code: string) => [status, { code, message: expect.any(String) }];
    const json = { 'Content-Type': 'application/json' };
    const send = (headers: Record<string, string>, body: unknown) =>
      answer(`displays/${displayId}/signals`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
    const offer = { type: 'offer', payload: 'o1' };
    // The device header: missing, then one character over 64.
    expect(await send(ctx.headers, offer)).toEqual(refusal(400, 'invalid_request'));
    expect(await send({ ...ctx.headers, 'X-Tally-Device-Id': 'd'.repeat(65) }, offer)).toEqual(refusal(400, 'invalid_request'));
    // A valid header, with a field the route does not know, then a type outside offer, answer and ice.
    const till = { ...ctx.headers, 'X-Tally-Device-Id': 'till-i2', 'X-Tally-Device-Key': device.deviceKey };
    expect(await send(till, { ...offer, extra: 1 })).toEqual(refusal(400, 'invalid_request'));
    expect(await send(till, { type: 'bye', payload: 'o1' })).toEqual(refusal(400, 'invalid_request'));
    // The claim's own bounds: an empty name, a name of 101 characters, a code of 33.
    const claim = (body: unknown) => answer('display/claim', { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect(await claim({ code: '123456', displayName: '' })).toEqual(refusal(400, 'invalid_request'));
    expect(await claim({ code: '123456', displayName: 'n'.repeat(101) })).toEqual(refusal(400, 'invalid_request'));
    expect(await claim({ code: '1'.repeat(33), displayName: 'Counter' })).toEqual(refusal(400, 'invalid_request'));
    // No display token on the display's own routes.
    expect(await answer('display/signals', { method: 'GET' })).toEqual(refusal(401, 'token_refused'));
    expect(await answer('display/snapshot', { method: 'GET' })).toEqual(refusal(401, 'token_refused'));
    expect(await stored()).toEqual(before);
  });

  it('(j) another channel\'s till holding every check code never uses up a till\'s check codes', async () => {
    await fresh();
    // A till in channel B holds a pending claim on every check code, 0000 to 9999, live for 10 minutes on the service's clock.
    await connection.rawConnection.query(`INSERT INTO "tally_display_pending" ("id", "channelId", "deviceId", "secretHash", "displayName",
      "checkCode", "expiresAt") SELECT 'hog-' || n, $1, 'till-hog', md5('hog-' || n), 'Hog', lpad(n::text, 4, '0'), $2
      FROM generate_series(0, 9999) AS n`, [environment.decode(channels.b.id), new Date(Date.now() + offset + 10 * MINUTE)]);
    expect(await count('tally_display_pending')).toBe(10_000);
    const ctx = await pairTill('check-codes');
    const device = await register(ctx, 'till-j');
    const { code } = await signalling.mint(ctx, device);
    const claim = await signalling.claim(display('192.0.2.80'), { code, displayName: 'Counter' });
    expect(claim.checkCode).toMatch(/^\d{4}$/);
    expect((await signalling.pending(ctx, device)).map(p => p.checkCode)).toEqual([claim.checkCode]);
  });

  it('(k) the store-wide cap holds under parallel claims across both instances', async () => {
    await fresh();
    const { code } = await mintAs(await pairTill('store-race'), 'till-k');
    // 130 wrong claims from 13 sources, 10 each, so no source limit alone stops them before the store's 100.
    const results = await Promise.all(Array.from({ length: 130 }, (_, i) =>
      refused(signalling.claim(display(`198.51.100.${1 + (i % 13)}`, i % 2 ? second.url : base), { code: '000000x', displayName: 'Guess' }))));
    expect(results).toEqual(Array(130).fill('claim_refused'));
    const [store] = await connection.rawConnection.query(`SELECT "failures" FROM "tally_display_claim_window" WHERE "key" = 'store'`);
    expect(Number(store.failures)).toBe(100);
    expect(await refused(signalling.claim(display('192.0.2.90'), { code, displayName: 'Counter' }))).toBe('claim_refused');
    expect(await count('tally_display_code', 'NOT "spent"')).toBe(1);
  });

  it('(l) a channel\'s live pending claims stop at 50, and other channels still pair', async () => {
    await fresh();
    // 50 live pending claims in channel A, one each under 50 devices, live for 10 minutes on the service's clock.
    await connection.rawConnection.query(`INSERT INTO "tally_display_pending" ("id", "channelId", "deviceId", "secretHash", "displayName",
      "checkCode", "expiresAt") SELECT 'full-' || n, $1, 'till-full-' || n, md5('full-' || n), 'Full', '0000', $2
      FROM generate_series(1, 50) AS n`, [environment.decode(channels.a.id), new Date(Date.now() + offset + 10 * MINUTE)]);
    const { code } = await mintAs(await pairTill('pending-cap'), 'till-l');
    const d = display('192.0.2.100');
    expect(await refused(signalling.claim(d, { code, displayName: 'Counter' }))).toBe('claim_refused');
    expect(await count('tally_display_code', `"code" = '${code}' AND NOT "spent"`)).toBe(1);
    expect(await count('tally_display_claim_window', `"key" = 'store' AND "failures" > 0`)).toBe(0);
    await connection.rawConnection.query(`DELETE FROM "tally_display_pending" WHERE "id" = 'full-1'`);
    expect((await signalling.claim(d, { code, displayName: 'Counter' })).checkCode).toMatch(/^\d{4}$/);
    const other = await mintAs(await pairTill('pending-cap', 'b'), 'till-l-b');
    expect((await signalling.claim(display('192.0.2.101'), { code: other.code, displayName: 'Counter' })).checkCode).toMatch(/^\d{4}$/);
  });
});
