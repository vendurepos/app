import { randomUUID } from 'node:crypto';
import { RequestContextService, TransactionalConnection, User } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, RegisterService, TallyCommand, TallyPosPlugin } from '../src';
import type { RegisterEnvelope } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import { TEST_HOOKS_ENV } from '../src/service/order-create.service';
import { RefundService } from '../src/service/refund.service';
import type { CommandResult, OrderRefundEnvelope, RegisterCommandType } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// The request's clock, read once per request (TallyUI #337): the client-time upper bound is a day later.
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const AT = '2026-09-30T10:00:00.000Z';
const uuid = () => randomUUID();

type Envelope = { id: string; payload: object };
type Send<C extends Envelope> = (command: C, channelToken?: string) => Promise<Omit<CommandResult, 'warnings'>>;
/** Installs `hold` inside the command's transaction, after its claim; returns the seam's removal. */
type Seam = (hold: () => Promise<void>) => () => void;

// ADR 0002 §2: each command type's claim race, replay read, other payload and other channel, before and after B1b.
describe('command replay, one per command', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, run } = environment;
  let connection: TransactionalConnection;
  let registers: RegisterService;
  let second: { token: string };
  let superadmin: User;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    registers = server.app.get(RegisterService);
    const { zones } = await adminClient.query<{ zones: { items: Array<{ id: string; name: string }> } }>(
      parse('query { zones { items { id name } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) {
        createChannel(input: $input) { ... on Channel { id token } ... on ErrorResult { message } }
      }`), { input: {
      code: 'replay-second', token: 'replay-second-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    second = { token: createChannel.token };
    await server.app.get(TallyPosPlugin).onApplicationBootstrap();
    superadmin = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
  });
  afterAll(() => server.destroy());

  // As the route calls the services: a custom-API context marked as the route's, in the default or the given channel.
  const context = async (channelToken?: string, user?: User) =>
    markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom', channelOrToken: channelToken, user }));
  const sendRegister: Send<RegisterEnvelope> = async (command, channelToken) =>
    registers.apply(await context(channelToken), command, { requestTimeMs: NOW });
  const sendRefund: Send<OrderRefundEnvelope<Record<string, unknown>>> = async (command, channelToken) =>
    server.app.get(RefundService).apply(await context(channelToken, superadmin), command, { requestTimeMs: NOW });

  const envelope = (type: RegisterCommandType, payload: Record<string, unknown>): RegisterEnvelope =>
    ({ id: uuid(), type, version: 1, createdAt: AT, deviceId: 'till-1', attempt: 1, payload });
  const open = (sessionId: string, registerId: string) =>
    envelope('register.session.open', { sessionId, registerId, openedAt: AT, countedFloatMinor: 10000 });
  const movement = (sessionId: string) => envelope('register.movement.record',
    { movementId: uuid(), sessionId, type: 'paid_in', amountMinor: 500, reason: 'float', createdAt: AT });
  async function opened() {
    const [sessionId, registerId] = [uuid(), uuid()];
    expect(await sendRegister(open(sessionId, registerId))).toMatchObject({ status: 'applied' });
    return { sessionId, registerId };
  }

  // Polls pg_stat_activity, outside every command, until a statement on the ledger table waits on a lock.
  async function claimWaits(limitMs: number) {
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      const rows = await connection.rawConnection.query(`SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`, ['%INSERT INTO%tally_command%']);
      if (rows.length) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }
  const registerSeam: Seam = hold => {
    const lock = registers.lockRegister.bind(registers);
    const spy = vi.spyOn(registers, 'lockRegister').mockImplementation(async (tx, registerId) => {
      await hold();
      return lock(tx, registerId);
    });
    return () => spy.mockRestore();
  };

  async function proveReplay<C extends Envelope>(command: C, send: Send<C>, seam: Seam, changed: Record<string, unknown>) {
    // (a) The claim race: the first claim holds its transaction open until the second claim waits on its row.
    let waited: boolean | undefined;
    const remove = seam(async () => {
      if (waited !== undefined) return;
      waited = false;
      waited = await claimWaits(4_000);
    });
    let results: Awaited<ReturnType<Send<C>>>[];
    try {
      results = await Promise.all([send(command), send(command)]);
    } finally {
      remove();
    }
    expect(waited, 'the second claim waited on the first').toBe(true);
    expect(results.map(result => result.status).sort(), JSON.stringify(results)).toEqual(['applied', 'duplicate']);
    const applied = results.find(result => result.status === 'applied')!;
    expect(results.find(result => result.status !== 'applied')).toEqual({ ...applied, status: 'duplicate' });
    // (b) The replay read.
    expect(await send(command)).toEqual({ ...applied, status: 'duplicate' });
    // (c) Another payload.
    expect(await send({ ...command, payload: { ...command.payload, ...changed } })).toEqual({ id: command.id, status: 'rejected',
      error: { code: 'idempotency_mismatch', message: 'Command id was already used with a different payload' } });
    // (d) Another channel: refused, and the ledger row is unchanged.
    const ledger = connection.rawConnection.getRepository(TallyCommand);
    const row = await ledger.findOneByOrFail({ id: command.id });
    expect(await send(command, second.token)).toEqual({ id: command.id, status: 'rejected', error: {
      code: 'idempotency_mismatch', message: 'Command id was already used in another channel', data: { reason: 'command_in_other_channel' },
    } });
    expect(await ledger.findOneByOrFail({ id: command.id })).toEqual(row);
  }

  it('order.create', async () => {
    const recipe = server.app.get(OrderCreateService);
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    const seam: Seam = hold => {
      recipe.testHooks.beforeFirstWrite = async id => {
        if (id === command.id) await hold();
      };
      process.env[TEST_HOOKS_ENV] = '1';
      return () => {
        delete process.env[TEST_HOOKS_ENV];
        recipe.testHooks = {};
      };
    };
    await proveReplay(command, run, seam, { cashierRef: 'other-cashier' });
  });

  it('register.session.open', async () => {
    await proveReplay(open(uuid(), uuid()), sendRegister, registerSeam, { sessionId: uuid() });
  });

  it('register.session.transition', async () => {
    const { sessionId } = await opened();
    await proveReplay(envelope('register.session.transition', { sessionId, status: 'counting', at: AT }), sendRegister, registerSeam,
      { sessionId: uuid() });
  });

  it('register.movement.record', async () => {
    const { sessionId } = await opened();
    await proveReplay(movement(sessionId), sendRegister, registerSeam, { sessionId: uuid() });
  });

  it('register.movement.void', async () => {
    const { sessionId } = await opened();
    const target = movement(sessionId);
    expect(await sendRegister(target)).toMatchObject({ status: 'applied' });
    await proveReplay(envelope('register.movement.void', { movementId: uuid(), sessionId, voids: target.payload.movementId, createdAt: AT }),
      sendRegister, registerSeam, { sessionId: uuid() });
  });

  it('register.closure.submit', async () => {
    const { sessionId, registerId } = await opened();
    await proveReplay(envelope('register.closure.submit', {
      closureId: uuid(), sessionId, registerId, number: 1, openedAt: AT, closedAt: AT, tillExpected: { cash: 10000 }, counted: { cash: 10000 },
      periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0,
      unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '3.0.0-next.1', orderIds: [], movementIds: [],
    }), sendRegister, registerSeam, { sessionId: uuid() });
  });

  it('order.refund', async () => {
    const session = await opened();
    const sale = await run(orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]));
    expect(sale).toMatchObject({ status: 'applied' });
    const { order } = await adminClient.query<{
      order: { id: string; shippingWithTax: number; lines: Array<{ id: string; quantity: number; proratedLinePriceWithTax: number }> };
    }>(parse('query Order($id: ID!) { order(id: $id) { id shippingWithTax lines { id quantity proratedLinePriceWithTax } } }'),
    { id: sale.serverRefs!.orderId });
    // The whole order: a whole line's share is its line total (ADR 0007).
    const command: OrderRefundEnvelope<Record<string, unknown>> = { id: uuid(), type: 'order.refund', version: 1, createdAt: AT,
      deviceId: 'till-1', attempt: 1, payload: {
      clientRefundId: uuid(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt: AT,
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity, restock: false })),
      shippingMinor: order.shippingWithTax, adjustmentMinor: 0, destination: 'original_method', reason: 'Returned at till',
      totalMinor: order.lines.reduce((sum, line) => sum + line.proratedLinePriceWithTax, 0) + order.shippingWithTax,
    } };
    await proveReplay(command, sendRefund, registerSeam, { reason: 'Another reason' });
  });
});
