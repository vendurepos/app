import {
  Channel, Order, OrderLine, OrderService, Payment, PaymentMethod, ShippingMethod,
  StockMovement, TaxRate, TransactionalConnection,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TransientCommandError } from '../src';
import type { CommandEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('ledger: stored rejections, idempotency and transient failures', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds, run } = environment;
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

  const command = (variantId = serviceIds.mug[0]) => orderCommand([{ variantId, quantity: 1, unitPriceMinor: 800 }]);
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
    const input = command(kind === 'disabled' ? serviceIds.print[0] : '999999');
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

  it('proof 12: after a commit whose answer was lost, the retry returns duplicate with the committed orderId', async () => {
    const input = command();
    const lost = await run(input);
    const committed = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    expect(committed.state).toBe('Delivered');
    expect(await run(input)).toMatchObject({ status: 'duplicate', serverRefs: { orderId: String(committed.id) } });
    expect(lost.serverRefs!.orderId).toBe(String(committed.id));
    expect(await ordersFor(input)).toBe(1);
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

  it('any other exception is neither transient nor stored: it propagates, the claim rolls back, and the retry applies', async () => {
    const input = command();
    const before = await counts();
    recipe.testObserver = async (_stage, _ctx, order) => {
      if (order.customFields.tallyClientOrderId === input.payload.clientOrderId) throw new Error('injected recipe exception');
    };
    const failed = await timed(run(input));
    recipe.testObserver = undefined;
    expect(failed.error).toBeInstanceOf(Error);
    expect(failed.error).not.toBeInstanceOf(TransientCommandError);
    expect((failed.error as Error).message).toBe('injected recipe exception');
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });
});
