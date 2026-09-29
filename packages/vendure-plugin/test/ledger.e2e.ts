import {
  Channel, Logger, Order, OrderLine, OrderService, Payment, PaymentMethod, RequestContextService, ShippingMethod,
  StockLocationService, StockMovement, TaxRate, TransactionalConnection,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TransientCommandError } from '../src';
import { markTallyRoute, tallyPaymentHandler } from '../src/config/strategies';
import { TEST_HOOKS_ENV } from '../src/service/order-create.service';
import { PluginBugError } from '../src/service/errors';
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

  it.each(['disabled', 'missing', 'disabled-product'] as const)('proof 10, re-ruling 4, B1: a %s variant is unknown_variant stored on the claim; the recipe never runs', async kind => {
    const input = command(kind === 'disabled' ? variantIds.print[0] : kind === 'missing' ? encode(999999) : variantIds.beans[0]);
    // B1: an enabled variant of a disabled product, which addItemToOrder would throw on after the claim.
    const { productVariant } = await adminClient.query<{ productVariant: { product: { id: string } } }>(parse(`query Product($id: ID!) {
      productVariant(id: $id) { product { id } } }`), { id: variantIds.beans[0] });
    const setProduct = (enabled: boolean) => adminClient.query(parse(`mutation Product($id: ID!, $enabled: Boolean!) {
      updateProduct(input: { id: $id, enabled: $enabled }) { id } }`), { id: productVariant.product.id, enabled });
    if (kind === 'disabled-product') await setProduct(false);
    const before = await counts();
    const createDraft = vi.spyOn(server.app.get(OrderService), 'createDraft'); // Calls Vendure unchanged.
    try {
      const result = await run(input);
      const replay = await run(input);
      expect(result).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'unknown_variant' } });
      expect(replay).toEqual(result);
      expect(createDraft).not.toHaveBeenCalled();
      expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
      expect(await ledgerFor(input)).toMatchObject({ status: 'rejected', result });
    } finally {
      createDraft.mockRestore();
      if (kind === 'disabled-product') await setProduct(true);
    }
  });

  it('ADR-038 #220: a quantity at or below 0, fractional or above int4 is an unstored invalid_payload, before any claim', async () => {
    const claim = vi.spyOn(recipe as unknown as { claim: () => Promise<unknown> }, 'claim');
    try {
      for (const quantity of [0, -1, 1.5, 2_147_483_648]) {
        const input = command();
        input.payload.lines[0].quantity = quantity;
        const result = await run(input);
        expect(result, String(quantity)).toEqual({ id: input.id, status: 'rejected', error: {
          code: 'invalid_payload', message: quantity > 2_147_483_647 ? 'lines[0].quantity: expected at most 2147483647' : 'lines[0].quantity: expected a positive integer',
        } });
        expect(await ledgerFor(input)).toBeNull();
      }
      expect(claim).not.toHaveBeenCalled();
    } finally {
      claim.mockRestore();
    }
  });

  it('TallyUI #219 R2: a PluginBugError before the recipe\'s first write is a stored internal_error; nothing is written; the replay returns it', async () => {
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: 'vp2-r2@example.com' });
    const before = await counts();
    const logged = vi.spyOn(Logger, 'error');
    recipe.testHooks.beforeFirstWrite = async id => {
      if (id === input.id) throw new PluginBugError('injected invariant before the first write');
    };
    process.env[TEST_HOOKS_ENV] = '1';
    try {
      const result = await run(input);
      expect(result).toEqual({ id: input.id, status: 'rejected', error: {
        code: 'internal_error', message: expect.stringMatching(/^Internal error \(ref [0-9a-f-]{36}\)$/),
        data: { correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      } });
      // ADR-038's shape: the message names the same correlation id as the data.
      expect(result.error!.message).toBe(`Internal error (ref ${(result.error!.data as { correlationId: string }).correlationId})`);
      expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
      expect(JSON.stringify(await ledgerFor(input))).not.toContain('injected');
      const { correlationId } = result.error!.data as { correlationId: string };
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${correlationId}.*injected invariant`)), 'TallyPosPlugin', expect.any(String));
      recipe.testHooks = {};
      expect(await run(input)).toEqual(result);
    } finally {
      delete process.env[TEST_HOOKS_ENV];
      recipe.testHooks = {};
      logged.mockRestore();
    }
  });

  it('S1: a customer email above 254 characters is invalid_payload, unstored, after the replay read and before the claim', async () => {
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined,
      { email: `${'a'.repeat(243)}@example.com` });
    expect(input.payload.customer!.email).toHaveLength(255);
    expect(await run(input)).toEqual({ id: input.id, status: 'rejected', error: {
      code: 'invalid_payload', message: 'customer.email: expected at most 254 characters',
    } });
    expect(await ledgerFor(input)).toBeNull();
  });

  it('N1: a declined tally-pos payment (here, a context without the route mark) is store_configuration, not stored, never underpaid', async () => {
    const input = command();
    const before = await counts();
    const unmarked = await server.app.get(RequestContextService).create({ apiType: 'custom' });
    expect(await recipe.create(unmarked, input)).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'store_configuration' } });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    // Not stored: from the route, the same id applies.
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it('review 1: a tally-pos payment Authorized by its handler is store_configuration, not stored, never underpaid; a replaced handler is refused after the claim, unstored', async () => {
    const input = command();
    const before = await counts();
    const handler = vi.spyOn(tallyPaymentHandler, 'createPayment')
      .mockImplementationOnce(async (_ctx, _order, amount) => ({ amount, state: 'Authorized' as const, metadata: {}, method: 'tally-pos' }));
    try {
      expect(await run(input)).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'store_configuration' } });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      handler.mockRestore();
    }
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    // A method whose handler is no longer the plugin's is store-wide setup: refused after the claim, which rolls back unstored.
    const methods = connection.rawConnection.getRepository(PaymentMethod);
    const method = await methods.findOneByOrFail({ code: 'tally-pos' });
    await methods.update(method.id, { handler: { code: 'dummy-payment-handler', args: [] } });
    try {
      expect(await run(input)).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await counts()).toEqual(before);
    } finally {
      await methods.update(method.id, { handler: method.handler });
    }
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it('review 4: U+0000 in any string is invalid_payload during shape validation, before any database access', async () => {
    const repositories = vi.spyOn(connection, 'getRepository');
    try {
      for (const [path, set] of [
        ['payload.clientOrderId', (input: ReturnType<typeof command>) => { input.payload.clientOrderId = 'a\u0000b'; }],
        ['payload.registerId', (input: ReturnType<typeof command>) => { input.payload.registerId = 'till\u0000'; }],
        ['payload.customer.email', (input: ReturnType<typeof command>) => { input.payload.customer = { email: 'a\u0000@example.com' }; }],
      ] as const) {
        const input = command();
        set(input);
        expect(await run(input), path).toEqual({ id: input.id, status: 'rejected', error: {
          code: 'invalid_payload', message: `${path}: must not contain U+0000`,
        } });
      }
      expect(repositories).not.toHaveBeenCalled();
    } finally {
      repositories.mockRestore();
    }
  });

  it('#12 nit 5: a clientLineId repeated within one payload is invalid_payload during shape validation, unstored', async () => {
    const inputs = ([2, 3] as const).map(version => orderCommand([
      { clientLineId: 'vp2b-line', variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 },
      { clientLineId: 'vp2b-line', variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800 },
    ], undefined, undefined, { version }));
    const before = await counts();
    const repositories = vi.spyOn(connection, 'getRepository');
    try {
      for (const input of inputs) {
        expect(await run(input), `v${input.version}`).toEqual({ id: input.id, status: 'rejected', error: {
          code: 'invalid_payload', message: 'lines[1].clientLineId: expected no duplicate clientLineId',
        } });
      }
      expect(repositories).not.toHaveBeenCalled();
    } finally {
      repositories.mockRestore();
    }
    expect(await counts()).toEqual(before);
  });

  it('nit: a customerId over 64 characters or unknown is ignored with a customer_ignored warning, never refused', async () => {
    for (const [customerId, reason] of [['T_'.padEnd(80, '9'), 'too_long'], [encode(999999), 'unknown']] as const) {
      const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { customerId });
      const result = await run(input);
      expect(result, reason).toMatchObject({ status: 'applied' });
      expect(result.warnings, reason).toEqual([{ code: 'customer_ignored', customerId: customerId.slice(0, 64), reason }]);
    }
  });

  it('proof 10, TallyUI #219: a default tax zone with all its rates disabled is store_configuration, not stored; the same id applies once repaired', async () => {
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
    // Not stored, the claim released: the same id applies once the store is repaired.
    expect(await run(input)).toMatchObject({ status: 'applied' });
  });

  it.each(['payment', 'shipping'] as const)('TallyUI #219: a missing channel POS %s method is store_configuration, not stored', async kind => {
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

  it('ordering ruling: a same-channel collision is answered before a pre-claim check that would now refuse (the variant disabled since)', async () => {
    const input = command(variantIds.beans[1]);
    const first = await run(input);
    expect(first).toMatchObject({ status: 'applied' });
    const setEnabled = (enabled: boolean) => adminClient.query(parse(`mutation Enable($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.beans[1], enabled }] });
    await setEnabled(false);
    try {
      // Not vacuous: a new sale of the variant is refused before the claim.
      expect(await run(command(variantIds.beans[1]))).toMatchObject({ status: 'rejected', error: { code: 'unknown_variant' } });
      const requeued = { ...input, id: command().id };
      expect(await run(requeued)).toEqual({ ...first, id: requeued.id });
      expect(await ledgerFor(requeued)).toMatchObject({ status: 'applied' });
      expect(await run(requeued)).toEqual({ ...first, id: requeued.id, status: 'duplicate' });
      expect(await ordersFor(input)).toBe(1);
    } finally {
      await setEnabled(true);
    }
  });

  it('proof 11(c), refinement 2: a requeue with a new id of an applied sale is stored applied with its refs and warnings; its replay is duplicate', async () => {
    // Beans: 11 sold of 10 on hand, so the first result carries an insufficient_stock warning.
    const input = orderCommand([{ variantId: variantIds.beans[0], quantity: 11, unitPriceMinor: 800 }]);
    const first = await run(input);
    expect(first).toMatchObject({ status: 'applied', warnings: [{ code: 'insufficient_stock' }] });
    const before = await counts();
    const requeued = { ...input, id: command().id };
    const result = await run(requeued);
    expect(result).toEqual({ ...first, id: requeued.id });
    expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
    expect(await ledgerFor(requeued)).toMatchObject({ status: 'applied', result, clientOrderId: input.payload.clientOrderId });
    expect(await run(requeued)).toEqual({ ...result, status: 'duplicate' });
    expect(await ordersFor(input)).toBe(1);
  });

  it('refinement 2: a new id for a sale still in progress waits on the unique key as long as a claim, then 409; afterwards it is stored applied', async () => {
    // A new buyer, so the second command waits only on the unique key, not on the first's customer row.
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined,
      { email: 'vp2-in-progress@example.com' });
    const gate = hold(input);
    const first = timed(run(input));
    await gate.reached;
    const requeued = { ...input, id: command().id };
    const second = await timed(run(requeued));
    gate.release();
    const a = await first;
    recipe.testObserver = undefined;
    expect(second.error).toBeInstanceOf(TransientCommandError);
    expect(second.error).toMatchObject({ commandId: requeued.id, kind: 'lock', cause: { driverError: { code: '55P03' } } });
    expect(second.ms).toBeGreaterThanOrEqual(4800);
    expect(second.ms).toBeLessThan(6500);
    expect(await ledgerFor(requeued)).toBeNull();
    expect(a.value).toMatchObject({ status: 'applied' });
    expect(await run(requeued)).toEqual({ ...a.value, id: requeued.id });
    expect(await ordersFor(input)).toBe(1);
  });

  it('refinement 1: a programming error in the plugin\'s own code before the claim is transient; nothing is stored', async () => {
    const input = command();
    const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
    // A channel without its currency list makes the pre-claim currency check raise a TypeError in the service.
    const broken = ctx.copy(Object.assign(Object.create(Object.getPrototypeOf(ctx.channel)), ctx.channel, { availableCurrencyCodes: undefined }));
    const failed = await recipe.create(broken, input).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TransientCommandError);
    expect(failed).toMatchObject({ commandId: input.id, kind: 'unclassified', cause: expect.any(TypeError) });
    expect(await ledgerFor(input)).toBeNull();
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

  it('ADR-038 #220: createdAt has only an upper bound (one day ahead), unstored; a very old sale applies', async () => {
    const day = 24 * 60 * 60 * 1000;
    const at = (ms: number) => new Date(ms).toISOString();
    const before = await counts();
    for (const [path, value] of [
      ['createdAt', at(Date.now() + day + 60_000)], ['createdAt', 'not a date'], ['payload.createdAt', at(Date.now() + day + 60_000)],
    ]) {
      const input = command();
      if (path === 'createdAt') input.createdAt = value;
      else input.payload.createdAt = value;
      expect(await run(input), `${path} ${value}`).toEqual({ id: input.id, status: 'rejected', error: {
        code: 'invalid_payload', message: `${path}: expected a time no later than one day from now`,
      } });
      expect(await ledgerFor(input)).toBeNull();
    }
    expect(await counts()).toEqual(before);
    // No lower bound: an offline till sends old sales.
    for (const value of ['1969-07-20T20:17:00Z', '2001-01-01T00:00:00Z', at(Date.now() + day - 60_000)]) {
      const input = command();
      input.createdAt = value;
      input.payload.createdAt = value;
      expect(await run(input), value).toMatchObject({ status: 'applied' });
    }
  });

  it('ADR-038 #220: a lost-response replay answers duplicate through the replay read, with no claim, even when its createdAt is now beyond the window', async () => {
    const day = 24 * 60 * 60 * 1000;
    const input = command();
    input.createdAt = input.payload.createdAt = new Date(Date.now() + day - 60_000).toISOString();
    const first = await run(input);
    expect(first).toMatchObject({ status: 'applied' });
    // The server clock moves back two days: the sale's createdAt is now beyond the window.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 2 * day);
    const claim = vi.spyOn(recipe as unknown as { claim: () => Promise<unknown> }, 'claim');
    try {
      const fresh = { ...command(), createdAt: input.createdAt };
      expect(await run(fresh)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(await run(input)).toEqual({ ...first, status: 'duplicate' });
      expect(claim).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      claim.mockRestore();
    }
  });

  // Front desk (TallyUI #222 review): the length bounds run after the replay read and the collision lookup,
  // so an applied command whose values are now over a bound still replays. Both values fit varchar(255).
  async function appliedOverBounds(tag: string) {
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined,
      { email: `${tag}${'a'.repeat(243 - tag.length)}@example.com` });
    input.payload.sessionId = 's'.repeat(40);
    expect(input.payload.customer!.email).toHaveLength(255);
    // The command was applied before today's bounds.
    // A step-1 length bound would refuse this apply itself, so a mutation that restores one
    // fails here, at the setup, by design.
    const values = vi.spyOn(recipe as unknown as { valueRefusal: () => unknown }, 'valueRefusal').mockReturnValue(undefined);
    try {
      const first = await run(input);
      expect(first).toMatchObject({ status: 'applied' });
      return { input, first };
    } finally {
      values.mockRestore();
    }
  }

  it('TallyUI #222 review: an applied command with a sessionId and email now over their bounds replays as duplicate, with no claim', async () => {
    const { input, first } = await appliedOverBounds('r');
    const claim = vi.spyOn(recipe as unknown as { claim: () => Promise<unknown> }, 'claim');
    try {
      const fresh = { ...input, id: command().id, payload: { ...input.payload, clientOrderId: command().payload.clientOrderId } };
      expect(await run(fresh)).toEqual({ id: fresh.id, status: 'rejected', error: {
        code: 'invalid_payload', message: 'sessionId: expected at most 36 characters; customer.email: expected at most 254 characters',
      } });
      expect(await ledgerFor(fresh)).toBeNull();
      expect(await run(input)).toEqual({ ...first, status: 'duplicate' });
      expect(claim).not.toHaveBeenCalled();
    } finally {
      claim.mockRestore();
    }
  });

  it('TallyUI #222 review: a new id for an applied sale whose values are now over their bounds is answered by the collision guard, never invalid_payload', async () => {
    const { input, first } = await appliedOverBounds('c');
    const before = await counts();
    const requeued = { ...input, id: command().id };
    const result = await run(requeued);
    expect(result).toEqual({ ...first, id: requeued.id });
    expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
    expect(await ledgerFor(requeued)).toMatchObject({ status: 'applied', result, clientOrderId: input.payload.clientOrderId });
    expect(await run(requeued)).toEqual({ ...result, status: 'duplicate' });
    expect(await ordersFor(input)).toBe(1);
  });

  it('ruling 1: an exception from outside the plugin\'s code, even a TypeError, is transient; nothing is stored; the retry applies', async () => {
    for (const thrown of [new Error('injected recipe exception'), new TypeError('injected type error')]) {
      const input = command();
      const before = await counts();
      recipe.testObserver = async (_stage, _ctx, order) => {
        if (order.customFields.tallyClientOrderId === input.payload.clientOrderId) throw thrown;
      };
      const failed = await run(input).catch((error: unknown) => error);
      recipe.testObserver = undefined;
      expect(failed).toBeInstanceOf(TransientCommandError);
      expect(failed).toMatchObject({ commandId: input.id, kind: 'unclassified', cause: thrown });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
      expect(await run(input)).toMatchObject({ status: 'applied' });
    }
  });

  it('ruling 1: an unknown SQLSTATE inside the recipe (22012 division_by_zero) is transient; nothing is stored', async () => {
    const input = command();
    const before = await counts();
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage !== 'finalPass' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      await connection.getRepository(ctx, Order).query('SELECT 1 / 0');
    };
    const failed = await run(input).catch((error: unknown) => error);
    recipe.testObserver = undefined;
    expect(failed).toMatchObject({ commandId: input.id, kind: 'unclassified', cause: { driverError: { code: '22012' } } });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
  });

  it('re-ruling 3, N5: a PluginBugError after the first event keeps the partial sale for an admin; the rejection releases the id and flags the order', async () => {
    // Beans: 11 sold of 10 on hand, so the recipe tops up at the default location, which this
    // stub makes undefined after createDraft (the first event): the recipe's invariant check raises a PluginBugError.
    const input = orderCommand([{ variantId: variantIds.beans[0], quantity: 11, unitPriceMinor: 800 }]);
    const logged = vi.spyOn(Logger, 'error');
    const locations = vi.spyOn(server.app.get(StockLocationService), 'defaultStockLocation').mockResolvedValueOnce(undefined as never);
    try {
      await expect(run(input)).rejects.toMatchObject({ commandId: input.id, kind: 'needs_admin' });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`order.create ${input.id} needs an admin`), 'TallyPosPlugin', expect.any(String));
    } finally {
      locations.mockRestore();
      logged.mockRestore();
    }
    const orders = connection.rawConnection.getRepository(Order);
    const [draft] = await orders.find({ where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } } });
    expect(draft.state).toBe('Draft');
    expect(await ledgerFor(input)).toMatchObject({ status: 'needs_admin', result: { serverRefs: { orderId: encode(draft.id) } } });
    // Resends and a new id for the same sale answer 409; nothing runs again.
    await expect(run(input)).rejects.toMatchObject({ kind: 'needs_admin' });
    const retry = { ...input, id: command().id };
    await expect(run(retry)).rejects.toMatchObject({ kind: 'needs_admin' });
    // Re-rulings 1 and 2: the rejection cancels the order, moves its client id to tallyRejectedClientOrderId and flags it.
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    await recipe.resolveNeedsAdmin(ctx, input.id, 'rejected', 'partial sale discarded');
    expect(await orders.findOneByOrFail({ id: draft.id })).toMatchObject({ state: 'Cancelled', customFields: {
      tallyClientOrderId: null, tallyRejectedClientOrderId: input.payload.clientOrderId, tallyRejected: true,
    } });
    // Idempotent: a repeat finds the row resolved and changes nothing.
    await expect(recipe.resolveNeedsAdmin(ctx, input.id, 'rejected', 'again')).rejects.toThrow('does not need an admin');
    // The Retry's new id is a new sale, the only live order for the client id.
    expect(await run(retry)).toMatchObject({ id: retry.id, status: 'applied' });
    expect(await ordersFor(input)).toBe(1);
  });
});
