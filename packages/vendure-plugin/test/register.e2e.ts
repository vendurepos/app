import { randomUUID } from 'node:crypto';
import { RequestContextService, StockMovementService, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, RegisterService, TallyCommand } from '../src';
import type { RegisterEnvelope, RegisterResult } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import { TEST_HOOKS_ENV } from '../src/service/order-create.service';
import { parseCommandResult } from '../src/vendored/command-result';
import type { RegisterCommandType } from '../src/vendored/core-commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// The request's clock, read once per request (TallyUI #337): the client-time upper bound is a day later.
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const UPPER = '2026-10-02T00:00:00Z';
const AT = '2026-09-30T10:00:00.000Z';
const uuid = () => randomUUID();

// ADR 0003: TallyUI's five register commands at contract version 1.
describe('register commands', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, run } = environment;
  let registers: RegisterService;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    registers = server.app.get(RegisterService);
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  // As the route calls it: a custom-API context marked as the route's, in the default channel.
  async function send(command: RegisterEnvelope, requestTimeMs = NOW) {
    const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
    return registers.apply(ctx, command, { requestTimeMs });
  }
  const envelope = (type: RegisterCommandType, payload: Record<string, unknown>): RegisterEnvelope =>
    ({ id: uuid(), type, version: 1, createdAt: AT, deviceId: 'till-1', attempt: 1, payload });
  const open = (sessionId: string, registerId: string, extra = {}) =>
    envelope('register.session.open', { sessionId, registerId, openedAt: AT, countedFloatMinor: 10000, ...extra });
  const transition = (sessionId: string, status: string, extra = {}) =>
    envelope('register.session.transition', { sessionId, status, at: AT, ...extra });
  const movement = (sessionId: string, type: string, amountMinor: number, extra = {}) => envelope('register.movement.record',
    { movementId: uuid(), sessionId, type, amountMinor, reason: 'float', createdAt: AT, ...extra });
  const voidOf = (sessionId: string, voids: unknown, extra = {}) =>
    envelope('register.movement.void', { movementId: uuid(), sessionId, voids, createdAt: AT, ...extra });
  const closure = (sessionId: string, registerId: string, number: number, extra = {}) => envelope('register.closure.submit', {
    closureId: uuid(), sessionId, registerId, number, openedAt: AT, closedAt: AT, tillExpected: { cash: 10000 }, counted: { cash: 10000 },
    periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0,
    unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '3.0.0-next.1', orderIds: [], movementIds: [], ...extra,
  });
  const ledger = (command: { id: string }) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id });
  const movementId = (command: RegisterEnvelope) => command.payload.movementId as string;
  async function applyAll(...commands: RegisterEnvelope[]) {
    for (const command of commands) expect(await send(command), command.type).toMatchObject({ status: 'applied' });
  }
  // A refusal, exactly; a stored one's ledger row holds it and its resend answers it again, an unstored one leaves no row.
  async function refused(command: RegisterEnvelope, code: string, message: string, stored: boolean, data?: Record<string, unknown>) {
    const result = await send(command);
    expect(result).toEqual({ id: command.id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
    expect(await ledger(command)).toEqual(stored ? expect.objectContaining({ status: 'rejected', clientOrderId: null }) : null);
    if (stored) expect(await send(command)).toEqual(result);
  }

  it('each type applies with a register result that parses, replays as duplicate with the result recorded at apply, and another payload is idempotency_mismatch', async () => {
    const [s, r] = [uuid(), uuid()];
    const paidIn = movement(s, 'paid_in', 500);
    const commands = [open(s, r), transition(s, 'counting'), paidIn, voidOf(s, movementId(paidIn)),
      transition(s, 'closed', { counted: { cash: 9950, external: 0 }, closedBy: 'cashier-1', approvedBy: 'manager-1' }), closure(s, r, 1)];
    const results: RegisterResult[] = [];
    for (const command of commands) {
      const result = await send(command);
      expect(parseCommandResult(result)).toEqual(result);
      expect(result.serverRefs).toBeUndefined();
      results.push(result);
    }
    const session = (status: string, cash: number) => ({ session: { id: s, status, expected: { cash }, salesCount: 0 } });
    expect(results.map(result => [result.status, result.register])).toEqual([
      ['applied', session('open', 10000)], ['applied', session('counting', 10000)], ['applied', session('counting', 10500)],
      ['applied', session('counting', 10000)], ['applied', session('closed', 10000)],
      ['applied', { closure: { serverClosureId: commands[5].payload.closureId, number: 1, expected: { cash: 10000 }, variance: { cash: 0 } },
        counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0 } }],
    ]);
    for (const [index, command] of commands.entries()) {
      // After the close: the open and the movement still replay the state they recorded.
      expect(await send(command)).toEqual({ ...results[index], status: 'duplicate' });
      expect(await send({ ...command, payload: { ...command.payload, sessionId: uuid() } })).toEqual({ id: command.id, status: 'rejected',
        error: { code: 'idempotency_mismatch', message: 'Command id was already used with a different payload' } });
      expect(await ledger(command)).toMatchObject({ status: 'applied', result: results[index] });
    }
    const future = { ...open(uuid(), uuid()), version: 3 };
    expect(await send(future)).toEqual({ id: future.id, status: 'rejected', error: { code: 'unsupported_version',
      message: 'register version 3 is not supported; this server supports 1, 2', data: { register: 2 } } });
  });

  it('register_session_already_open names the winner and is stored: its resend is rejected the same', async () => {
    const [winner, r] = [uuid(), uuid()];
    await applyAll(open(winner, r));
    const second = open(uuid(), r);
    await refused(second, 'register_session_already_open', `Register ${r} already has session ${winner} open`, true, { sessionId: winner });
  });

  it('register_session_closed, stored: a transition out of closed, and a movement or a void after the close', async () => {
    const [s, r] = [uuid(), uuid()];
    const paidIn = movement(s, 'paid_in', 100);
    // A closing transition to a closed session is the same status: an applied no-op.
    await applyAll(open(s, r), paidIn, transition(s, 'closed'), transition(s, 'closed'));
    for (const command of [transition(s, 'open'), transition(s, 'counting'), movement(s, 'paid_out', 50), voidOf(s, movementId(paidIn))]) {
      await refused(command, 'register_session_closed', `Session ${s} is closed`, true);
    }
    await applyAll(open(uuid(), r));
  });

  it('register_session_closed, stored: a movement, a void or a counting transition once the closure is submitted, with no closing transition', async () => {
    const [s, r] = [uuid(), uuid()];
    const paidIn = movement(s, 'paid_in', 100);
    await applyAll(open(s, r), paidIn, closure(s, r, 1, { movementIds: [movementId(paidIn)], tillExpected: { cash: 10100 } }));
    for (const command of [movement(s, 'paid_out', 50), voidOf(s, movementId(paidIn)), transition(s, 'counting')]) {
      await refused(command, 'register_session_closed', `Session ${s} is closed`, true);
    }
    expect((await send(transition(s, 'closed'))).register).toEqual({ session: { id: s, status: 'closed', expected: { cash: 10100 }, salesCount: 0 } });
  });

  it('a closure applies only the voids in its movementIds: a void recorded after the till froze its list leaves its target counted, as on the Z', async () => {
    const [s, r] = [uuid(), uuid()];
    const paidIn = movement(s, 'paid_in', 500);
    const stranded = voidOf(s, movementId(paidIn));
    await applyAll(open(s, r), paidIn);
    // The live figure applies every void of the session.
    expect((await send(stranded)).register).toEqual({ session: { id: s, status: 'open', expected: { cash: 10000 }, salesCount: 0 } });
    await applyAll(transition(s, 'closed', { counted: { cash: 10500 } }));
    const submit = closure(s, r, 1, { movementIds: [movementId(paidIn)], tillExpected: { cash: 10500 }, counted: { cash: 10500 } });
    expect((await send(submit)).register).toMatchObject({ closure: { expected: { cash: 10500 }, variance: { cash: 0 } } });
  });

  it('register_closure_exists and register_closure_number_invalid are stored with their data', async () => {
    const [s, r] = [uuid(), uuid()];
    await applyAll(open(s, r), transition(s, 'closed'));
    const first = closure(s, r, 1, { perpetualSalesTotalMinor: 4200 });
    await applyAll(first);
    const again = closure(s, r, 2);
    await refused(again, 'register_closure_exists', `Session ${s} has closure ${first.payload.closureId}`, true, { closureId: first.payload.closureId });
    const s2 = uuid();
    await applyAll(open(s2, r), transition(s2, 'closed'));
    await refused(closure(s2, r, 3), 'register_closure_number_invalid', 'Closure number 3 is not 2', true,
      { counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 4200, perpetualRefundsTotalMinor: 0 } });
    expect(await send(closure(s2, r, 2))).toMatchObject({ register: { counters: { lastClosureNumber: 2 } } });
  });

  it('an unknown session, a missing or voided void target and a closure on another register are invalid_payload, unstored', async () => {
    const [s, r] = [uuid(), uuid()];
    const early = movement(s, 'paid_in', 100);
    await refused(early, 'invalid_payload', `sessionId: unknown session ${s}`, false);
    // Re-evaluated on resend: once the session is open, the same command applies.
    await applyAll(open(s, r), early);
    const target = uuid();
    await refused(voidOf(s, target), 'invalid_payload', `voids: no movement ${target} in session ${s}`, false);
    // A movement of another session is no target here.
    const [other, otherMovement] = [uuid(), movement(uuid(), 'paid_in', 1)];
    otherMovement.payload.sessionId = other;
    await applyAll(open(other, uuid()), otherMovement);
    await refused(voidOf(s, movementId(otherMovement)), 'invalid_payload', `voids: no movement ${movementId(otherMovement)} in session ${s}`, false);
    // A movement is voided once.
    await applyAll(voidOf(s, movementId(early)));
    await refused(voidOf(s, movementId(early)), 'invalid_payload', `voids: movement ${movementId(early)} is already voided`, false);
    await applyAll(transition(s, 'closed'));
    await refused(closure(s, uuid(), 1), 'invalid_payload', `registerId: expected the session's register ${r}`, false);
  });

  it('refuses unknown fields, map keys other than cash and external, and bad amounts and reasons, naming each path, unstored', async () => {
    const [s, r] = [uuid(), uuid()];
    const unknown = (path: string, type: string, what = 'field') => `${path}: unknown ${what} in register.${type} version 1`;
    const reason = 'reason: expected a non-empty string after trim of at most 500 characters';
    const cases: Array<[RegisterEnvelope, string]> = [
      [{ ...open(s, r), extra: 1 } as RegisterEnvelope, unknown('envelope.extra', 'session.open')],
      [open(s, r, { floatMinor: 1 }), unknown('floatMinor', 'session.open')],
      [transition(s, 'counting', { note: 'x' }), unknown('note', 'session.transition')],
      [movement(s, 'paid_in', 1, { currency: 'EUR' }), unknown('currency', 'movement.record')],
      [voidOf(s, 'm-1', { reason: 'x' }), unknown('reason', 'movement.void')],
      [closure(s, r, 1, { expected: { cash: 1 } }), unknown('expected', 'closure.submit')],
      [transition(s, 'closed', { counted: { cash: 1, card: 2 } }), unknown('counted.card', 'session.transition', 'key')],
      [closure(s, r, 1, { tillExpected: { cash: 1, voucher: 1 }, counted: { card: 2 } }),
        `${unknown('counted.card', 'closure.submit', 'key')}; ${unknown('tillExpected.voucher', 'closure.submit', 'key')}`],
      [movement(s, 'paid_in', 0), 'amountMinor: expected a safe integer >= 1'],
      [movement(s, 'paid_out', -5), 'amountMinor: expected a safe integer >= 1'],
      [movement(s, 'no_sale', 5), 'amountMinor: expected 0 for no_sale'],
      [movement(s, 'paid_in', 1, { reason: '   ' }), reason],
      [movement(s, 'paid_in', 1, { reason: 'x'.repeat(501) }), reason],
    ];
    for (const [command, message] of cases) await refused(command, 'invalid_payload', message, false);
    // At the bounds: 500 characters, and no_sale's 0.
    await applyAll(open(s, r), movement(s, 'paid_in', 1, { reason: 'x'.repeat(500) }), movement(s, 'no_sale', 0));
  });

  it('client time: openedAt, at, closedAt and a movement\'s createdAt out of bounds or without a zone, with the contract\'s messages, unstored', async () => {
    const [s, r] = [uuid(), uuid()];
    const bounds = (path: string) => `${path} must be a time from 2020-01-01T00:00:00Z to ${UPPER}`;
    const format = (path: string) => `${path} must be an RFC 3339 time with Z or an offset`;
    const [early, zoneless] = ['2019-12-31T23:59:59Z', '2026-09-30T10:00:00'];
    const cases: Array<[RegisterEnvelope, string]> = [
      [open(s, r, { openedAt: early }), bounds('payload.openedAt')],
      [open(s, r, { openedAt: zoneless }), format('payload.openedAt')],
      [transition(s, 'counting', { at: early }), bounds('payload.at')],
      [transition(s, 'counting', { at: zoneless }), format('payload.at')],
      [movement(s, 'paid_in', 1, { createdAt: early }), bounds('payload.createdAt')],
      [movement(s, 'paid_in', 1, { createdAt: zoneless }), format('payload.createdAt')],
      [voidOf(s, 'm-1', { createdAt: zoneless }), format('payload.createdAt')],
      [closure(s, r, 1, { closedAt: early }), bounds('payload.closedAt')],
      [closure(s, r, 1, { closedAt: zoneless }), format('payload.closedAt')],
      // The envelope's first, then the payload's in field-kinds.md order; the bound is exact, shown to the second.
      [{ ...closure(s, r, 1, { openedAt: zoneless, closedAt: '2026-10-02T00:00:00.001Z' }), createdAt: early },
        [bounds('createdAt'), format('payload.openedAt'), bounds('payload.closedAt')].join('; ')],
    ];
    for (const [command, message] of cases) await refused(command, 'invalid_payload', message, false);
    await applyAll(open(s, r, { openedAt: '2026-10-02T02:00:00+02:00' }));
  });

  it('two opens of one register on two connections: the second waits on the register lock and is register_session_already_open naming the first', async () => {
    const r = uuid();
    const [a, b] = [open(uuid(), r), open(uuid(), r)];
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    // Holds a's transaction after its writes, its lock held and nothing committed.
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
      expect(ra).toMatchObject({ status: 'applied' });
      expect(rb).toMatchObject({ status: 'rejected', error: { code: 'register_session_already_open', data: { sessionId: a.payload.sessionId } } });
    } finally {
      release();
      delete process.env[TEST_HOOKS_ENV];
      registers.testHooks = {};
    }
  });

  it('figures: the live expected and salesCount, and a closure\'s expected, variance and counters, never counting a tallyRejected order', async () => {
    const [s, r] = [uuid(), uuid()];
    await applyAll(open(s, r));
    const sale = (variantId: string, quantity: number, unitPriceMinor: number, tenders?: Parameters<typeof orderCommand>[1]) => {
      const command = orderCommand([{ variantId, quantity, unitPriceMinor }], tenders);
      command.payload.sessionId = s;
      return command;
    };
    // Two mugs of 1000 each: cash with change (net 1000), and card.
    const cashSale = sale(variantIds.mug[0], 1, 800, [{ method: 'cash', amountMinor: 1000, tenderedMinor: 1500, changeMinor: 500 }]);
    const cardSale = sale(variantIds.mug[0], 1, 800, [{ method: 'external', amountMinor: 1000, reference: 'card-1' }]);
    for (const command of [cashSale, cardSale]) expect(await run(command)).toMatchObject({ status: 'applied' });
    // A sale of 16875 cash an admin rejected (its stock take-back failed, then resolveNeedsAdmin): tallyRejected, never counted.
    const rejectedSale = sale(variantIds.print[0], 3, 4500);
    const stock = server.app.get(StockMovementService);
    const adjust = stock.adjustProductVariantStock.bind(stock);
    const spy = vi.spyOn(stock, 'adjustProductVariantStock').mockImplementationOnce(adjust)
      .mockImplementationOnce(() => Promise.reject(new Error('injected take-back failure')));
    try {
      await expect(run(rejectedSale)).rejects.toMatchObject({ kind: 'needs_admin' });
    } finally {
      spy.mockRestore();
    }
    const adminCtx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    await server.app.get(OrderCreateService).resolveNeedsAdmin(adminCtx, rejectedSale.id, 'rejected', 'register figures test');
    const [paidIn, paidOut, noSale] = [movement(s, 'paid_in', 2000), movement(s, 'paid_out', 700), movement(s, 'no_sale', 0)];
    const voidIn = voidOf(s, movementId(paidIn));
    await applyAll(paidIn, paidOut, noSale);
    expect((await send(voidIn)).register).toEqual({ session: { id: s, status: 'open', expected: { cash: 10300, external: 1000 }, salesCount: 2 } });
    // Recorded after the till froze its list: the live figure counts it, the closure does not.
    const stranded = movement(s, 'paid_out', 100);
    expect((await send(stranded)).register).toMatchObject({ session: { expected: { cash: 10200, external: 1000 } } });
    await applyAll(transition(s, 'closed', { counted: { cash: 10250, external: 1000 } }));
    const submit = closure(s, r, 1, {
      orderIds: [cashSale.payload.clientOrderId, cardSale.payload.clientOrderId, rejectedSale.payload.clientOrderId, uuid()],
      movementIds: [paidIn, paidOut, noSale, voidIn].map(movementId), tillExpected: { cash: 10300, external: 1000 },
      counted: { cash: 10250, external: 1000 }, periodSalesTotalMinor: 2000, perpetualSalesTotalMinor: 2000,
    });
    expect(await send(submit)).toEqual({ id: submit.id, status: 'applied', register: {
      closure: { serverClosureId: submit.payload.closureId, number: 1, expected: { cash: 10300, external: 1000 }, variance: { cash: -50, external: 0 } },
      counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 2000, perpetualRefundsTotalMinor: 0 },
    } });
    const s2 = uuid();
    await applyAll(open(s2, r), transition(s2, 'closed'));
    await refused(closure(s2, r, 1), 'register_closure_number_invalid', 'Closure number 1 is not 2', true,
      { counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 2000, perpetualRefundsTotalMinor: 0 } });
  });

  it('/info advertises register [1, 2], and one batch applies order.create and register.session.open in array order', async () => {
    const base = await server.app.getUrl();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1' };
    const info = await (await fetch(`${base}/tally/v1/info`, { headers })).json();
    expect(info.contracts).toEqual({ 'order.create': [1, 2, 3, 4, 5], register: [1, 2], 'order.refund': [1] });
    const s = uuid();
    const opening = open(s, uuid());
    const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    sale.payload.sessionId = s;
    const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST', headers, body: JSON.stringify({ commands: [opening, sale] }) });
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results.map((result: RegisterResult) => [result.id, result.status])).toEqual([[opening.id, 'applied'], [sale.id, 'applied']]);
    expect(results[0].register).toEqual({ session: { id: s, status: 'open', expected: { cash: 10000 }, salesCount: 0 } });
    expect(results[1].serverRefs).toMatchObject({ totalMinor: 1000 });
  });
});
