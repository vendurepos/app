import { randomUUID } from 'node:crypto';
import { TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyRegister } from '../src/entities/register.entities';
import type { CommandResult } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

const uuid = () => randomUUID();
const now = () => new Date().toISOString();

describe('GET /tally/v1/registers/:id', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let base: string;
  beforeAll(async () => {
    await environment.init();
    base = await server.app.getUrl();
  });
  afterAll(() => server.destroy());

  const admin = () => ({ Authorization: `Bearer ${adminClient.getAuthToken()}` });
  async function post(command: unknown): Promise<CommandResult> {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...admin() },
      body: JSON.stringify({ commands: [command] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).results[0];
  }
  async function applied(command: { type: string }) {
    expect(await post(command), command.type).toMatchObject({ status: 'applied' });
  }
  async function get(path: string, headers: Record<string, string> = admin()) {
    const response = await fetch(`${base}/tally/v1/registers/${path}`, { headers });
    return { status: response.status, body: await response.json() };
  }
  async function tokenWith(permissions: Array<'TallyPosSell'>) {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `read-${randomUUID()}`, description: 'Till register read test', permissions, channelIds: [activeChannel.id] } });
    const emailAddress = `${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: 'Read', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const response = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") {
        ... on CurrentUser { id } ... on ErrorResult { errorCode } } }` }),
    });
    expect((await response.json()).data.login).toMatchObject({ id: expect.any(String) });
    const token = response.headers.get('vendure-auth-token');
    expect(token).toBeTruthy();
    return { Authorization: `Bearer ${token}` };
  }
  const envelope = (type: string, payload: Record<string, unknown>, version = 1) => ({
    id: uuid(), type, version, createdAt: now(), deviceId: 'read-till', attempt: 1, payload,
  });
  const open = (sessionId: string, registerId: string, extra = {}, version = 1) =>
    envelope('register.session.open', { sessionId, registerId, openedAt: now(), countedFloatMinor: 10000, ...extra }, version);
  const transition = (sessionId: string, status: string, extra = {}) =>
    envelope('register.session.transition', { sessionId, status, at: now(), ...extra });
  const closure = (sessionId: string, registerId: string, number: number, extra = {}) => envelope('register.closure.submit', {
    closureId: uuid(), sessionId, registerId, number, openedAt: now(), closedAt: now(), tillExpected: { cash: 10000 }, counted: { cash: 10000 },
    periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0,
    unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '3.0.0-next.1', orderIds: [], movementIds: [], ...extra,
  });
  const isIso = (value: unknown) => typeof value === 'string' && new Date(value).toISOString() === value;

  it('answers counters, the live session and no closures for a register with an open session', async () => {
    const [s, r] = [uuid(), uuid()];
    const opening = open(s, r, { deviceName: '  Front till  ' }, 2);
    await applied(opening);
    const { status, body } = await get(r);
    expect(status).toBe(200);
    expect(body).toEqual({
      version: 1,
      register: { id: r, receivedAt: expect.any(String) },
      counters: { lastClosureNumber: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0 },
      session: { id: s, status: 'open', openedAt: opening.payload.openedAt, openedBy: null, deviceId: 'read-till', deviceName: 'Front till',
        countedFloatMinor: 10000, expected: { cash: 10000 }, salesCount: 0 },
      closures: { items: [], totalItems: 0, skip: 0, take: 20 },
    });
    expect(isIso(body.register.receivedAt)).toBe(true);
  });

  it('lists closures newest first with their frozen figures and pages them', async () => {
    const r = uuid();
    const submits = [];
    for (const number of [1, 2, 3]) {
      const s = uuid();
      const counted = { cash: 10000 + number };
      const submit = closure(s, r, number, { counted });
      await applied(open(s, r));
      await applied(transition(s, 'closed', { counted }));
      await applied(submit);
      submits.push(submit);
    }
    const { status, body } = await get(r);
    expect(status).toBe(200);
    expect(body.closures.items.map((item: { number: number }) => item.number)).toEqual([3, 2, 1]);
    const { payload } = submits[2];
    expect(body.closures.items[0]).toEqual({
      ...payload, businessDay: null, closedBy: null, approvedBy: null,
      expected: { cash: 10000 }, variance: { cash: 3 }, receivedAt: expect.any(String),
      countedFloatMinor: 10000, paidInMinor: 0, paidOutMinor: 0,
    });
    expect(body.closures.items[0].closureId).toBe(payload.closureId);
    expect(isIso(body.closures.items[0].receivedAt)).toBe(true);
    expect(body.closures.items.map((item: { counted: unknown }) => item.counted)).toEqual([{ cash: 10003 }, { cash: 10002 }, { cash: 10001 }]);
    expect(body.session).toBeNull();
    expect(body.counters).toEqual({ lastClosureNumber: 3, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0 });
    expect(body.closures).toMatchObject({ totalItems: 3, skip: 0, take: 20 });

    const paged = await get(`${r}?skip=1&take=1`);
    expect(paged.status).toBe(200);
    expect(paged.body.closures.items.map((item: { number: number }) => item.number)).toEqual([2]);
    expect(paged.body.closures).toMatchObject({ totalItems: 3, skip: 1, take: 1 });
  });

  it('counts a sale in the live session', async () => {
    const [s, r] = [uuid(), uuid()];
    await applied(open(s, r));
    const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    sale.payload.sessionId = s;
    sale.payload.registerId = r;
    sale.createdAt = now();
    sale.payload.createdAt = sale.createdAt;
    await applied(sale);
    const { status, body } = await get(r);
    expect(status).toBe(200);
    expect(body.session.salesCount).toBe(1);
    expect(body.session.expected.cash).toBe(10000 + sale.payload.totalMinor);
  });

  it('a closure read carries the session\'s float and the cash paid in and out that its expected counted', async () => {
    const [s, r] = [uuid(), uuid()];
    await applied(open(s, r));
    const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    sale.payload.sessionId = s;
    sale.payload.registerId = r;
    sale.createdAt = now();
    sale.payload.createdAt = sale.createdAt;
    await applied(sale);
    const movement = (type: string, amountMinor: number) => envelope('register.movement.record',
      { movementId: uuid(), sessionId: s, type, amountMinor, reason: 'float', createdAt: now() });
    const voidOf = (target: ReturnType<typeof movement>) =>
      envelope('register.movement.void', { movementId: uuid(), sessionId: s, voids: target.payload.movementId, createdAt: now() });
    const [m1, m2, m3, m4, m5] = [movement('paid_in', 500), movement('paid_out', 200), movement('paid_out', 300),
      movement('paid_in', 400), movement('paid_in', 700)];
    const [v3, v4] = [voidOf(m3), voidOf(m4)];
    for (const command of [m1, m2, m3, v3, m4, v4, m5]) await applied(command);
    await applied(transition(s, 'closed', { counted: { cash: 10000 } }));
    // v4 and m5 are left out: the till's Z did not hold them.
    await applied(closure(s, r, 1, { orderIds: [sale.payload.clientOrderId],
      movementIds: [m1, m2, m3, v3, m4].map(command => command.payload.movementId) }));
    const { body } = await get(r);
    const item = body.closures.items[0];
    expect(item).toMatchObject({ countedFloatMinor: 10000, paidInMinor: 900, paidOutMinor: 200 });
    expect(item.expected.cash).toBe(item.countedFloatMinor + sale.payload.totalMinor + item.paidInMinor - item.paidOutMinor);
    expect(item.expected.cash).toBe(10000 + sale.payload.totalMinor + 700);
  });

  it('answers 404 register_not_found for an unknown register and for another channel\'s register', async () => {
    const unknown = uuid();
    expect(await get(unknown)).toEqual({ status: 404, body: { code: 'register_not_found', message: `Unknown register ${unknown}` } });
    const foreign = uuid();
    await server.app.get(TransactionalConnection).rawConnection.getRepository(TallyRegister).insert({ channelId: 'not-this-channel', id: foreign });
    expect(await get(foreign)).toEqual({ status: 404, body: { code: 'register_not_found', message: `Unknown register ${foreign}` } });
  });

  it('answers 400 invalid_query for a bad skip or take', async () => {
    const r = uuid();
    await applied(open(uuid(), r));
    const take = { code: 'invalid_query', message: 'take must be an integer from 1 to 100' };
    const skip = { code: 'invalid_query', message: 'skip must be an integer ≥ 0' };
    for (const [query, body] of [['take=0', take], ['take=101', take], ['skip=-1', skip], ['take=5x', take]] as const) {
      expect(await get(`${r}?${query}`), query).toEqual({ status: 400, body });
    }
  });

  it('is refused without TallyPosSell or CreateOrder', async () => {
    const r = uuid();
    await applied(open(uuid(), r));
    expect((await get(r, {})).status).toBe(403);
    expect((await get(r, await tokenWith(['TallyPosSell']))).status).toBe(200);
  });

  describe('GET /tally/v1/registers', () => {
    const list = async (headers: Record<string, string> = admin()) => {
      const response = await fetch(`${base}/tally/v1/registers`, { headers });
      return { status: response.status, body: await response.json() };
    };

    it('lists the channel\'s registers, newest session first, with their device names', async () => {
      const [r1, r2, foreign] = [uuid(), uuid(), uuid()];
      const first = open(uuid(), r1, { deviceName: '  Till one  ' }, 2);
      await applied(first);
      const second = open(uuid(), r2, { deviceName: 'Till two' }, 2);
      await applied(second);
      await server.app.get(TransactionalConnection).rawConnection.getRepository(TallyRegister).insert({ channelId: 'not-this-channel', id: foreign });
      const { status, body } = await list();
      expect(status).toBe(200);
      const item = (id: string, name: string, opening: ReturnType<typeof open>) => ({
        id, receivedAt: expect.any(String), lastDeviceName: name,
        session: { status: 'open', openedAt: opening.payload.openedAt, openedBy: null, deviceName: name },
      });
      expect(body.items.slice(0, 2)).toEqual([item(r2, 'Till two', second), item(r1, 'Till one', first)]);
      expect(body.items.map((entry: { id: string }) => entry.id)).not.toContain(foreign);
      expect(body.items.length).toBeLessThanOrEqual(100);
      expect((await list({})).status).toBe(403);
      expect((await list(await tokenWith(['TallyPosSell']))).status).toBe(200);
    });
  });
});
