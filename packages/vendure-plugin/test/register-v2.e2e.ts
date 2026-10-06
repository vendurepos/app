import { randomUUID } from 'node:crypto';
import { Order, RequestContextService, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegisterService, TallyCommand } from '../src';
import type { RegisterEnvelope } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import {
  TallyRegisterClosure, TallyRegisterMovement, TallyRegisterSession, TallyRegisterSessionAlias, TallyRegisterSessionStatus,
} from '../src/entities/register.entities';
import { TEST_HOOKS_ENV } from '../src/service/order-create.service';
import { parseCommandResult } from '../src/vendored/command-result';
import type { RegisterCommandType } from '../src/vendored/core-commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const AT = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T11:00:00.000Z';
const uuid = () => randomUUID();

describe('register v2 open: resume and take-over (ADR-078)', () => {
  const environment = createPluginTestEnvironment();
  const { server } = environment;
  let registers: RegisterService;
  let connection: TransactionalConnection;
  let channelId: string;
  beforeAll(async () => {
    await environment.init();
    registers = server.app.get(RegisterService);
    connection = server.app.get(TransactionalConnection);
    channelId = String((await server.app.get(RequestContextService).create({ apiType: 'custom' })).channelId);
  });
  afterAll(() => server.destroy());

  async function send(command: RegisterEnvelope, requestTimeMs = NOW) {
    const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
    return registers.apply(ctx, command, { requestTimeMs });
  }
  const envelope = (type: RegisterCommandType, payload: Record<string, unknown>, version = 2, deviceId = 'till-1'): RegisterEnvelope =>
    ({ id: uuid(), type, version, createdAt: AT, deviceId, attempt: 1, payload });
  const open = (sessionId: string, registerId: string, extra = {}, version = 2, deviceId = 'till-1') =>
    envelope('register.session.open', { sessionId, registerId, openedAt: AT, countedFloatMinor: 10000, ...extra }, version, deviceId);
  const transition = (sessionId: string, status: string) => envelope('register.session.transition', { sessionId, status, at: AT });
  const session = (id: string) => connection.rawConnection.getRepository(TallyRegisterSession).findOneBy({ channelId, id });
  const aliases = (sessionId: string) => connection.rawConnection.getRepository(TallyRegisterSessionAlias).findBy({ channelId, sessionId });

  it('records the envelope deviceId as sent and the trimmed deviceName', async () => {
    const s = uuid();
    expect(await send(open(s, uuid(), { deviceName: '  Front till  ' }, 2, ' till-1 '))).toMatchObject({ status: 'applied' });
    expect(await session(s)).toMatchObject({ deviceId: ' till-1 ', deviceName: 'Front till', supersedes: null });
  });

  it('rejects v1 deviceName and malformed v2 fields as unstored invalid_payload', async () => {
    const cases: Array<[RegisterEnvelope, string]> = [
      [open(uuid(), uuid(), { deviceName: 'Front till' }, 1), 'deviceName: requires register.session.open version 2, command is version 1'],
      [open(uuid(), uuid(), { deviceName: '   ' }), 'deviceName: expected a string of 1 to 64 characters after trim'],
      [open(uuid(), uuid(), { deviceName: 'x'.repeat(65) }), 'deviceName: expected a string of 1 to 64 characters after trim'],
      [open(uuid(), uuid(), { supersedes: '' }), 'supersedes: expected a non-empty string of at most 64 characters'],
    ];
    for (const [command, message] of cases) {
      expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: { code: 'invalid_payload', message } });
      expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id })).toBeNull();
    }
  });

  it('resumes its own live session with its opening figures and a permanent, replayable alias', async () => {
    const [s1, s2, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    const second = open(s2, r, { countedFloatMinor: 5000, openedAt: LATER });
    const resumed = { session: { id: s1, status: 'open', expected: { cash: 10000 }, salesCount: 0, openedAt: AT, openingFloatMinor: 10000 },
      resumed: { fromSessionId: s2 } };
    expect(await send(second)).toEqual({ id: second.id, status: 'applied', register: resumed });
    expect(await aliases(s1)).toEqual([expect.objectContaining({ id: s2, sessionId: s1, commandId: second.id })]);
    expect(await session(s2)).toBeNull();
    expect(await send(second)).toEqual({ id: second.id, status: 'duplicate', register: resumed });
    const third = { ...second, id: uuid() };
    expect(await send(third)).toEqual({ id: third.id, status: 'applied', register: resumed });
    expect(await aliases(s1)).toHaveLength(1);
    const sameId = open(s1, r);
    expect(await send(sameId)).toEqual({ id: sameId.id, status: 'applied', register: { session: resumed.session } });
    expect(await aliases(s1)).toHaveLength(1);
  });

  it('at v1 refuses the same device with exactly the v1 data and no alias', async () => {
    const [s1, s2, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r, {}, 1))).toMatchObject({ status: 'applied' });
    expect(await session(s1)).toMatchObject({ deviceId: 'till-1' });
    const second = open(s2, r, {}, 1);
    expect(await send(second)).toEqual({ id: second.id, status: 'rejected', error: { code: 'register_session_already_open',
      message: `Register ${r} already has session ${s1} open`, data: { sessionId: s1 } } });
    expect(await aliases(s1)).toEqual([]);
  });

  it('gives another device v2 details, omitting null openedBy and reporting the live status', async () => {
    const [s, r] = [uuid(), uuid()];
    expect(await send(open(s, r, { deviceName: 'Front till' }))).toMatchObject({ status: 'applied' });
    for (const status of ['open', 'counting']) {
      if (status === 'counting') expect(await send(transition(s, status))).toMatchObject({ status: 'applied' });
      const command = open(uuid(), r, {}, 2, 'till-2');
      expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: { code: 'register_session_already_open',
        message: `Register ${r} already has session ${s} open`, data: { sessionId: s, registerId: r, openedAt: AT,
          deviceId: 'till-1', deviceName: 'Front till', status } } });
    }
  });

  it('takes over and takes back; a superseded device does not resume its former session', async () => {
    const [s1, s3, s4, s5, r] = [uuid(), uuid(), uuid(), uuid(), uuid()];
    expect(await send(open(s1, r, { deviceName: 'Front till' }))).toMatchObject({ status: 'applied' });
    const takeover = open(s3, r, { supersedes: s1, openedAt: LATER }, 2, 'till-2');
    const result = await send(takeover);
    expect(result).toMatchObject({ status: 'applied', register: { session: { id: s3, status: 'open' } } });
    expect(result.register!.superseded).toEqual({ sessionId: s1, openedAt: AT, deviceId: 'till-1', deviceName: 'Front till' });
    expect(await session(s3)).toMatchObject({ supersedes: s1 });
    expect(await connection.rawConnection.getRepository(TallyRegisterSessionStatus).findOne({
      where: { channelId, sessionId: s1 }, order: { seq: 'DESC' },
    })).toMatchObject({ status: 'superseded', at: LATER, commandId: takeover.id, counted: null, closedBy: null, approvedBy: null });
    expect(await send(open(s4, r))).toMatchObject({ status: 'rejected', error: { code: 'register_session_already_open', data: { sessionId: s3 } } });
    expect(await send(open(s5, r, { supersedes: s3 }))).toMatchObject({ status: 'applied', register: {
      session: { id: s5, status: 'open' }, superseded: { sessionId: s3 },
    } });
  });

  it('takes over a counting session', async () => {
    const [s1, s2, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(transition(s1, 'counting'))).toMatchObject({ status: 'applied' });
    expect(await send(open(s2, r, { supersedes: s1 }, 2, 'till-2'))).toMatchObject({ status: 'applied', register: {
      session: { id: s2, status: 'open' }, superseded: { sessionId: s1 },
    } });
  });

  it('takes over when supersedes names an alias of the live session', async () => {
    const [s1, alias, s2, r] = [uuid(), uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(alias, r))).toMatchObject({ status: 'applied', register: { resumed: { fromSessionId: alias } } });
    expect(await send(open(s2, r, { supersedes: alias }, 2, 'till-2'))).toMatchObject({ status: 'applied', register: {
      session: { id: s2, status: 'open' }, superseded: { sessionId: s1 },
    } });
    expect(await session(s2)).toMatchObject({ supersedes: s1 });
  });

  it('refuses supersedes naming a superseded session, naming the current live session and recording no new session', async () => {
    const [s1, s2, s3, r] = [uuid(), uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(s2, r, { supersedes: s1 }, 2, 'till-2'))).toMatchObject({ status: 'applied' });
    expect(await send(open(s3, r, { supersedes: s1 }))).toMatchObject({ status: 'rejected', error: {
      code: 'register_session_already_open', data: { sessionId: s2 },
    } });
    expect(await session(s3)).toBeNull();
  });

  it('opens plainly with null supersedes when nothing is live', async () => {
    const [s1, s2, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(transition(s1, 'closed'))).toMatchObject({ status: 'applied' });
    const command = open(s2, r, { supersedes: s1 }, 2, 'till-2');
    expect(await send(command)).toEqual({ id: command.id, status: 'applied', register: {
      session: { id: s2, status: 'open', expected: { cash: 10000 }, salesCount: 0 },
    } });
    expect(await session(s2)).toMatchObject({ supersedes: null });
  });

  it('two take-overs on two connections: the second waits on the register lock and is refused naming the first', async () => {
    const [s, r] = [uuid(), uuid()];
    expect(await send(open(s, r))).toMatchObject({ status: 'applied' });
    const [a, b] = [open(uuid(), r, { supersedes: s }, 2, 'till-2'), open(uuid(), r, { supersedes: s }, 2, 'till-3')];
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    registers.testHooks.afterWrites = async id => {
      if (id !== a.id) return;
      entered();
      await released;
    };
    process.env[TEST_HOOKS_ENV] = '1';
    try {
      const first = send(a);
      await reached;
      const second = send(b);
      let waiting = false;
      for (const start = performance.now(); !waiting && performance.now() - start < 5000;) {
        waiting = (await connection.rawConnection.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      release();
      const [ra, rb] = await Promise.all([first, second]);
      expect(waiting).toBe(true);
      expect(ra).toMatchObject({ status: 'applied', register: { session: { id: a.payload.sessionId }, superseded: { sessionId: s } } });
      expect(rb).toMatchObject({ status: 'rejected', error: { code: 'register_session_already_open', data: { sessionId: a.payload.sessionId } } });
      expect(await session(b.payload.sessionId as string)).toBeNull();
    } finally {
      release();
      delete process.env[TEST_HOOKS_ENV];
      registers.testHooks = {};
    }
  });
});

describe('register v2 later commands: aliases and superseded sessions (ADR-078)', () => {
  const environment = createPluginTestEnvironment();
  const { server, variantIds, run } = environment;
  let registers: RegisterService;
  let connection: TransactionalConnection;
  let channelId: string;
  beforeAll(async () => {
    await environment.init();
    registers = server.app.get(RegisterService);
    connection = server.app.get(TransactionalConnection);
    channelId = String((await server.app.get(RequestContextService).create({ apiType: 'custom' })).channelId);
  });
  afterAll(() => server.destroy());

  async function send(command: RegisterEnvelope, requestTimeMs = NOW) {
    const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
    return registers.apply(ctx, command, { requestTimeMs });
  }
  const envelope = (type: RegisterCommandType, payload: Record<string, unknown>, version = 2, deviceId = 'till-1'): RegisterEnvelope =>
    ({ id: uuid(), type, version, createdAt: AT, deviceId, attempt: 1, payload });
  const open = (sessionId: string, registerId: string, extra = {}, version = 2, deviceId = 'till-1') =>
    envelope('register.session.open', { sessionId, registerId, openedAt: AT, countedFloatMinor: 10000, ...extra }, version, deviceId);
  const transition = (sessionId: string, status: string) => envelope('register.session.transition', { sessionId, status, at: AT });
  const session = (id: string) => connection.rawConnection.getRepository(TallyRegisterSession).findOneBy({ channelId, id });
  const aliases = (sessionId: string) => connection.rawConnection.getRepository(TallyRegisterSessionAlias).findBy({ channelId, sessionId });
  const movement = (sessionId: string, type = 'paid_in', amountMinor = 2000) => envelope('register.movement.record',
    { movementId: uuid(), sessionId, type, amountMinor, reason: 'float', createdAt: AT });
  const closure = (sessionId: string, registerId: string) => envelope('register.closure.submit', {
    closureId: uuid(), sessionId, registerId, number: 1, openedAt: AT, closedAt: LATER,
    tillExpected: { cash: 10000 }, counted: { cash: 10000 },
    periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0,
    unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '3.0.0-next.1', orderIds: [], movementIds: [],
  });

  it('applies alias movements, transitions and voids to the resolved session', async () => {
    const [s1, s2, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(s2, r))).toMatchObject({ status: 'applied', register: { resumed: { fromSessionId: s2 } } });
    const record = movement(s2);
    expect(await send(record)).toMatchObject({ status: 'applied', register: { session: { id: s1 } } });
    expect(await connection.rawConnection.getRepository(TallyRegisterMovement).findOneBy({ channelId, commandId: record.id }))
      .toMatchObject({ sessionId: s1 });
    expect(await send(transition(s2, 'counting'))).toMatchObject({ status: 'applied', register: { session: { id: s1, status: 'counting' } } });
    expect(await connection.rawConnection.getRepository(TallyRegisterSessionStatus).findOne({
      where: { channelId, sessionId: s1 }, order: { seq: 'DESC' },
    })).toMatchObject({ status: 'counting' });
    const voidCommand = envelope('register.movement.void', { sessionId: s2, movementId: uuid(), voids: record.payload.movementId, createdAt: AT });
    expect(await send(voidCommand)).toMatchObject({ status: 'applied', register: { session: { id: s1, expected: { cash: 10000 } } } });
    expect(await connection.rawConnection.getRepository(TallyRegisterMovement).findOneBy({ channelId, commandId: voidCommand.id }))
      .toMatchObject({ sessionId: s1, voids: record.payload.movementId });
  });

  it('stores the v2 superseded refusal for movements, closing transitions and closures without register writes', async () => {
    const [s1, s3, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r, { openedBy: 'ann' }))).toMatchObject({ status: 'applied' });
    expect(await send(open(s3, r, { supersedes: s1, openedAt: LATER, openedBy: 'bob', deviceName: ' Back till ' }, 2, 'till-2')))
      .toMatchObject({ status: 'applied' });
    const where = { channelId, sessionId: s1 };
    const statuses = await connection.rawConnection.getRepository(TallyRegisterSessionStatus).findBy(where);
    const error = { code: 'register_session_superseded', message: `Session ${s1} was taken over by session ${s3}`, data: {
      sessionId: s1, supersededAt: (await session(s3))!.openedAt, supersededBy: 'bob', deviceId: 'till-2', deviceName: 'Back till', newSessionId: s3,
    } };
    for (const command of [movement(s1), transition(s1, 'closed'), closure(s1, r)]) {
      const result = { id: command.id, status: 'rejected', error };
      expect(await send(command)).toEqual(result);
      expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id }))
        .toMatchObject({ status: 'rejected', result });
      expect(await send(command)).toEqual(result);
    }
    expect(await connection.rawConnection.getRepository(TallyRegisterMovement).findBy(where)).toEqual([]);
    expect(await connection.rawConnection.getRepository(TallyRegisterSessionStatus).findBy(where)).toEqual(statuses);
    expect(await connection.rawConnection.getRepository(TallyRegisterClosure).findBy(where)).toEqual([]);
  });

  it('refuses through an alias with the resolved id and omits null take-over fields', async () => {
    const [s1, s2, s3, r] = [uuid(), uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(s2, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(s3, r, { supersedes: s1, openedAt: LATER }, 2, 'till-2'))).toMatchObject({ status: 'applied' });
    const command = movement(s2);
    expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: {
      code: 'register_session_superseded', message: `Session ${s1} was taken over by session ${s3}`,
      data: { sessionId: s1, supersededAt: (await session(s3))!.openedAt, deviceId: 'till-2', newSessionId: s3 },
    } });
  });

  it('stores the v1 closed refusal for a superseded session without data', async () => {
    const [s1, s3, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(s3, r, { supersedes: s1 }, 2, 'till-2'))).toMatchObject({ status: 'applied' });
    const command = { ...movement(s1), version: 1 };
    const result = { id: command.id, status: 'rejected', error: { code: 'register_session_closed', message: `Session ${s1} is closed` } };
    expect(await send(command)).toEqual(result);
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id }))
      .toMatchObject({ status: 'rejected', result });
    expect(await send(command)).toEqual(result);
  });

  it('counts cash sales carrying either the session id or an alias in the live figures', async () => {
    const [s1, s2, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    expect(await send(open(s2, r))).toMatchObject({ status: 'applied' });
    for (const [sessionId, quantity] of [[s2, 1], [s1, 2]] as const) {
      const command = orderCommand([{ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800 }],
        [{ method: 'cash', amountMinor: quantity * 1000 }]);
      command.payload.sessionId = sessionId;
      expect(await run(command)).toMatchObject({ status: 'applied' });
    }
    const command = movement(s1, 'no_sale', 0);
    expect(await send(command)).toEqual({ id: command.id, status: 'applied', register: {
      session: { id: s1, status: 'open', expected: { cash: 13000 }, salesCount: 2 },
    } });
  });

  it('refuses a same-device resume onto a session id recorded on another register and keeps the live session', async () => {
    const [s0, s1, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s0, uuid()))).toMatchObject({ status: 'applied' });
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    const command = open(s0, r);
    expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: {
      code: 'invalid_payload', message: `sessionId: session ${s0} is already recorded`,
    } });
    expect(await aliases(s1)).toEqual([]);
    expect(await send(movement(s1))).toMatchObject({ status: 'applied', register: { session: { id: s1, status: 'open' } } });
  });

  it('refuses a take-over onto a session id recorded on another register without superseding the live session', async () => {
    const [s0, s1, r] = [uuid(), uuid(), uuid()];
    expect(await send(open(s0, uuid()))).toMatchObject({ status: 'applied' });
    expect(await send(open(s1, r))).toMatchObject({ status: 'applied' });
    const command = open(s0, r, { supersedes: s1 }, 2, 'till-2');
    expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: {
      code: 'invalid_payload', message: `sessionId: session ${s0} is already recorded`,
    } });
    expect(await connection.rawConnection.getRepository(TallyRegisterSessionStatus).findBy({ channelId, sessionId: s1, status: 'superseded' }))
      .toEqual([]);
    expect(await send(movement(s1))).toMatchObject({ status: 'applied', register: { session: { id: s1, status: 'open' } } });
  });
});

describe('order.create register session warnings (ADR-078 d7)', () => {
  const environment = createPluginTestEnvironment();
  const { server, variantIds, decode, encode, run } = environment;
  let registers: RegisterService;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    registers = server.app.get(RegisterService);
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  async function send(command: RegisterEnvelope) {
    const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
    return registers.apply(ctx, command, { requestTimeMs: NOW });
  }
  const envelope = (type: RegisterCommandType, payload: Record<string, unknown>): RegisterEnvelope =>
    ({ id: uuid(), type, version: 2, createdAt: AT, deviceId: 'till-1', attempt: 1, payload });
  const open = (sessionId: string, registerId: string) =>
    envelope('register.session.open', { sessionId, registerId, openedAt: AT, countedFloatMinor: 10000 });
  const mug = () => ({ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 });

  it('applies an order without a sessionId without warnings', async () => {
    // Without a session in the channel, an unguarded lookup would warn.
    const channelId = String((await server.app.get(RequestContextService).create({ apiType: 'custom' })).channelId);
    expect(await connection.rawConnection.getRepository(TallyRegisterSession).findBy({ channelId })).toEqual([]);
    expect(await connection.rawConnection.getRepository(TallyRegisterSessionAlias).findBy({ channelId })).toEqual([]);
    const command = orderCommand([mug()]);
    expect(command.payload).not.toHaveProperty('sessionId');
    const result = await run(command);
    expect(result.status).toBe('applied');
    expect(result).not.toHaveProperty('warnings');
  });

  it('applies an unknown session, retaining its id and a parsed, replayable warning', async () => {
    const sessionId = uuid();
    const command = orderCommand([mug()], undefined, undefined, { sessionId });
    const result = await run(command);
    const warnings = [{ code: 'register_session_unknown', sessionId }];
    expect(result.status).toBe('applied');
    expect(result.warnings).toEqual(warnings);
    const order = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: decode(result.serverRefs!.orderId) });
    expect(order.customFields.tallySessionId).toBe(sessionId);
    expect(parseCommandResult(result).warnings).toEqual(warnings);
    expect(await run(command)).toEqual({ ...result, status: 'duplicate' });
  });

  it('applies known sessions and same-device resume aliases without warnings', async () => {
    const [sessionId, alias, registerId] = [uuid(), uuid(), uuid()];
    expect(await send(open(sessionId, registerId))).toMatchObject({ status: 'applied' });
    expect(await send(open(alias, registerId))).toMatchObject({ status: 'applied', register: {
      session: { id: sessionId }, resumed: { fromSessionId: alias },
    } });
    for (const id of [sessionId, alias]) {
      const result = await run(orderCommand([mug()], undefined, undefined, { sessionId: id }));
      expect(result.status).toBe('applied');
      expect(result).not.toHaveProperty('warnings');
    }
  });

  it('appends the unknown session warning after customer_ignored', async () => {
    const sessionId = uuid();
    const customerId = encode(999999);
    const result = await run(orderCommand([mug()], undefined, { customerId }, { sessionId }));
    expect(result.status).toBe('applied');
    expect(result.warnings).toEqual([
      { code: 'customer_ignored', customerId, reason: 'unknown' },
      { code: 'register_session_unknown', sessionId },
    ]);
  });

  it('counts an order with an unknown session after that session opens', async () => {
    const sessionId = uuid();
    const result = await run(orderCommand([mug()], undefined, undefined, { sessionId }));
    expect(result.status).toBe('applied');
    expect(result.warnings).toEqual([{ code: 'register_session_unknown', sessionId }]);
    expect(await send(open(sessionId, uuid()))).toMatchObject({ status: 'applied' });
    const next = await send(envelope('register.session.transition', { sessionId, status: 'counting', at: LATER }));
    expect(next).toMatchObject({ status: 'applied', register: { session: { id: sessionId, salesCount: 1 } } });
  });
});
