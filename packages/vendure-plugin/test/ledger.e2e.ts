import {
  Channel, Logger, Order, OrderLine, OrderService, Payment, PaymentMethod, ShippingMethod,
  StockMovement, TaxRate, TransactionalConnection,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TransientCommandError, internalErrorCount } from '../src';
import type { CommandEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('ledger: stored rejections, idempotency and transient failures', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, encode, run } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let channel: Channel;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation SetLedgerFixtures($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id enabled }
    }`), { input: [
      { id: variantIds.mug[0], stockOnHand: 100 },
      { id: variantIds.print[0], enabled: false },
    ] });
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    channel = await connection.rawConnection.getRepository(Channel).findOneOrFail({
      where: { code: '__default_channel__' }, relations: ['defaultTaxZone'],
    });
  });
  afterAll(() => server.destroy());

  const command = (variantId = variantIds.mug[0]) => orderCommand([{ variantId, quantity: 1, unitPriceMinor: 800 }]);
  async function counts() {
    return {
      orders: await connection.rawConnection.getRepository(Order).count(),
      ledger: await connection.rawConnection.getRepository(TallyCommand).count(),
      lines: await connection.rawConnection.getRepository(OrderLine).count(),
      payments: await connection.rawConnection.getRepository(Payment).count(),
      stockMovements: await connection.rawConnection.getRepository(StockMovement).count(),
    };
  }
  const ordersFor = (input: ReturnType<typeof command>) => connection.rawConnection.getRepository(Order).count({
    where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
  });
  const ledgerFor = (input: CommandEnvelope) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id });
  const timed = async <T>(work: Promise<T>) => {
    const start = performance.now();
    const settled = await work.then(value => ({ value }), (error: unknown) => ({ error }));
    return { ...settled, ms: Math.round(performance.now() - start) } as { value?: T; error?: unknown; ms: number };
  };
  // Holds the command's transaction (claim and order written, uncommitted) at its first line until released.
  function hold(input: ReturnType<typeof command>) {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'addItemToOrder' && order.customFields.tallyClientOrderId === input.payload.clientOrderId) {
        entered();
        await released;
      }
    };
    return { reached, release };
  }
  afterEach(() => { recipe.testObserver = undefined; });

  it.each(['disabled', 'missing'] as const)('proof 10: a %s variant stores unknown_variant and a replay never runs the recipe', async kind => {
    const input = command(kind === 'disabled' ? variantIds.print[0] : encode(999999));
    const before = await counts();
    const createDraft = vi.spyOn(server.app.get(OrderService), 'createDraft'); // Calls Vendure unchanged.
    try {
      const result = await run(input);
      const replay = await run(input);
      expect(result).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'unknown_variant' } });
      expect(replay).toEqual(result);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
      expect(await ledgerFor(input)).toMatchObject({ status: 'rejected', result });
    } finally {
      createDraft.mockRestore();
    }
  });

  it('proof 10: a default tax zone with all its rates disabled gives pre-claim store_configuration', async () => {
    const repo = connection.rawConnection.getRepository(TaxRate);
    const rates = await repo.find({ where: { zoneId: channel.defaultTaxZone.id, enabled: true } });
    expect(rates.length).toBeGreaterThan(0);
    const before = await counts();
    const input = command();
    try {
      for (const rate of rates) await repo.update(rate.id, { enabled: false });
      expect(await run(input)).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
    } finally {
      for (const rate of rates) await repo.update(rate.id, { enabled: true });
    }
    // Not stored: the same id applies once the store is repaired.
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it.each(['payment', 'shipping'] as const)('a missing channel POS %s method is refused before the claim', async kind => {
    const entity = kind === 'payment' ? PaymentMethod : ShippingMethod;
    const repo = connection.rawConnection.getRepository(entity);
    const method = await repo.findOneOrFail({
      where: { code: kind === 'payment' ? 'tally-pos' : 'tally-in-store' }, relations: ['channels'],
    });
    const before = await counts();
    const input = command();
    try {
      await repo.createQueryBuilder().relation(entity, 'channels').of(method).remove(channel);
      expect(await run(input)).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
    } finally {
      await repo.createQueryBuilder().relation(entity, 'channels').of(method).add(channel);
    }
  });

  it('proof 11(a): a duplicate waits for a held 2 s transaction and returns the stored refs', async () => {
    const input = command();
    const gate = hold(input);
    const first = timed(run(input));
    await gate.reached;
    const second = timed(run(input));
    setTimeout(gate.release, 2000);
    const [a, b] = await Promise.all([first, second]);
    recipe.testObserver = undefined;
    expect(a.value).toMatchObject({ status: 'applied' });
    expect(b.value).toMatchObject({ status: 'duplicate', serverRefs: a.value!.serverRefs });
    expect(b.ms).toBeGreaterThanOrEqual(1500);
    expect(await ordersFor(input)).toBe(1);
    expect(await ledgerFor(input)).toMatchObject({ status: 'applied', result: a.value });
  });

  it('proof 11(b): a 7 s hold gives TransientCommandError(lock) after about 5 s, and duplicate after the commit', async () => {
    const input = command();
    const gate = hold(input);
    const first = timed(run(input));
    await gate.reached;
    const second = await timed(run(input));
    gate.release();
    const a = await first;
    recipe.testObserver = undefined;
    expect(second.error).toBeInstanceOf(TransientCommandError);
    expect(second.error).toMatchObject({ commandId: input.id, kind: 'lock' });
    expect(second.ms).toBeGreaterThanOrEqual(4800);
    expect(second.ms).toBeLessThan(6500);
    expect(a.value).toMatchObject({ status: 'applied' });
    const retry = await run(input);
    expect(retry).toMatchObject({ status: 'duplicate', serverRefs: a.value!.serverRefs });
    expect(await ordersFor(input)).toBe(1);
  });

  it('proof 11(c): a requeue with a new id returns applied and the existing refs without any write', async () => {
    const input = command();
    const first = await run(input);
    expect(first.status).toBe('applied');
    const before = await counts();
    const requeued = { ...input, id: command().id };
    expect(await run(requeued)).toEqual({ id: requeued.id, status: 'applied', serverRefs: first.serverRefs });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(requeued)).toBeNull();
  });

  it('proof 11(d): the same id with a changed payload is idempotency_mismatch', async () => {
    const input = command();
    const first = await run(input);
    expect(first.status).toBe('applied');
    const before = await counts();
    const changed = { ...input, payload: { ...input.payload, cashierRef: 'different-cashier' } };
    expect(await run(changed)).toMatchObject({ status: 'rejected', error: { code: 'idempotency_mismatch' } });
    expect(await counts()).toEqual(before);
    expect((await ledgerFor(input))?.result).toEqual(first);
  });

  // The crash-after-commit proof (12) needs the route and arrives in VP2; this is the replay it relies on.
  it('sequential replay: the same id after a commit returns duplicate with the committed orderId', async () => {
    const input = command();
    const first = await run(input);
    const committed = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    expect(committed.state).toBe('Delivered');
    expect(await run(input)).toMatchObject({ status: 'duplicate', serverRefs: { orderId: encode(committed.id) } });
    expect(first.serverRefs!.orderId).toBe(encode(committed.id));
    expect(await ordersFor(input)).toBe(1);
  });

  it('review 1: a committed command replays as duplicate even after the store stops passing the pre-claim checks', async () => {
    const input = command();
    const first = await run(input);
    expect(first.status).toBe('applied');
    const repo = connection.rawConnection.getRepository(TaxRate);
    const rates = await repo.find({ where: { zoneId: channel.defaultTaxZone.id, enabled: true } });
    try {
      for (const rate of rates) await repo.update(rate.id, { enabled: false });
      // A new command is refused before the claim, so the store really fails the check.
      expect(await run(command())).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await run(input)).toEqual({ ...first, status: 'duplicate' });
    } finally {
      for (const rate of rates) await repo.update(rate.id, { enabled: true });
    }
  });

  it('a statement timeout inside the recipe is a TransientCommandError(timeout); nothing is written; the retry applies', async () => {
    const input = command();
    const before = await counts();
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage !== 'finalPass' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      const repository = connection.getRepository(ctx, Order);
      await repository.query("SET LOCAL statement_timeout = '50ms'");
      await repository.query('SELECT pg_sleep(1)');
    };
    const failed = await timed(run(input));
    recipe.testObserver = undefined;
    expect(failed.error).toBeInstanceOf(TransientCommandError);
    expect(failed.error).toMatchObject({ commandId: input.id, kind: 'timeout' });
    expect(await counts()).toEqual(before);
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it('N5: a real deadlock inside the recipe is TransientCommandError(deadlock), not lock; nothing is written; the retry applies', async () => {
    const input = command();
    const before = await counts();
    // Another session holds advisory lock 2 and then waits for 1, which the recipe holds.
    const other = connection.rawConnection.createQueryRunner();
    await other.connect();
    await other.startTransaction();
    await other.query('SELECT pg_advisory_xact_lock(9002)');
    let theirs: Promise<unknown> | undefined;
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage !== 'finalPass' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      const repository = connection.getRepository(ctx, Order);
      await repository.query('SELECT pg_advisory_xact_lock(9001)');
      // The recipe waits first, so its deadlock check (after deadlock_timeout) finds the cycle and aborts it.
      const mine = repository.query('SELECT pg_advisory_xact_lock(9002)');
      await new Promise(resolve => setTimeout(resolve, 200));
      theirs = other.query('SELECT pg_advisory_xact_lock(9001)');
      await mine;
    };
    try {
      const failed = await timed(run(input));
      expect(failed.error).toBeInstanceOf(TransientCommandError);
      expect((failed.error as TransientCommandError).cause).toMatchObject({ driverError: { code: '40P01' } });
      expect(failed.error).toMatchObject({ commandId: input.id, kind: 'deadlock' });
    } finally {
      recipe.testObserver = undefined;
      await theirs;
      await other.commitTransaction();
      await other.release();
    }
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it('N5: a lock timeout inside the recipe, after the claim, is TransientCommandError(timeout), not lock', async () => {
    const input = command();
    const before = await counts();
    const other = connection.rawConnection.createQueryRunner();
    await other.connect();
    await other.startTransaction();
    await other.query('SELECT pg_advisory_xact_lock(9003)');
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage !== 'finalPass' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      const repository = connection.getRepository(ctx, Order);
      await repository.query("SET LOCAL lock_timeout = '50ms'");
      await repository.query('SELECT pg_advisory_xact_lock(9003)');
    };
    try {
      const failed = await timed(run(input));
      expect((failed.error as TransientCommandError).cause).toMatchObject({ driverError: { code: '55P03' } });
      expect(failed.error).toMatchObject({ commandId: input.id, kind: 'timeout' });
    } finally {
      recipe.testObserver = undefined;
      await other.commitTransaction();
      await other.release();
    }
    expect(await counts()).toEqual(before);
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it('ruling 8: any other exception after the claim is a stored internal_error, logged and counted; a replay returns it', async () => {
    const input = command();
    const before = await counts();
    const count = internalErrorCount();
    const logged = vi.spyOn(Logger, 'error');
    recipe.testObserver = async (_stage, _ctx, order) => {
      if (order.customFields.tallyClientOrderId === input.payload.clientOrderId) throw new Error('injected recipe exception');
    };
    try {
      const result = await run(input);
      expect(result).toEqual({ id: input.id, status: 'rejected', error: {
        code: 'internal_error', message: 'The server could not record the order',
        data: { message: 'Internal error', correlationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) },
      } });
      expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
      const row = await ledgerFor(input);
      expect(row).toMatchObject({ status: 'rejected', result });
      // N7: no part of the raw message is returned or stored; the log has it under the correlation id.
      for (const part of ['injected', 'recipe exception']) {
        expect(JSON.stringify(result)).not.toContain(part);
        expect(JSON.stringify(row)).not.toContain(part);
      }
      expect(internalErrorCount()).toBe(count + 1);
      const { correlationId } = result.error!.data as { correlationId: string };
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${correlationId}.*injected recipe exception`)),
        'TallyPosPlugin', expect.any(String));
      // The replay does not reach the recipe, so the observer would throw again if it did.
      expect(await run(input)).toEqual(result);
      expect(internalErrorCount()).toBe(count + 1);
      // A second failure gets its own id.
      const other = command();
      recipe.testObserver = async (_stage, _ctx, order) => {
        if (order.customFields.tallyClientOrderId === other.payload.clientOrderId) throw new Error('injected recipe exception');
      };
      expect((await run(other)).error!.data!.correlationId).not.toBe(correlationId);
    } finally {
      recipe.testObserver = undefined;
      logged.mockRestore();
    }
  });
});
