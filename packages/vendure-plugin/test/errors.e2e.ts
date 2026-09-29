import {
  Channel, ConfigService, Customer, InsufficientStockOnHandError, Order, OrderLine, OrderService, Payment,
  ProductVariantService, ShippingLine, StockMovement, Surcharge, TaxRate, TransactionalConnection, defaultOrderProcess,
} from '@vendure/core';
import type { OrderProcess, OrderState } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TransientCommandError, UNKNOWN_REJECTION_CODE } from '../src';
import { rejectionFor, transientKind } from '../src/service/errors';
import type { CommandEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// The trigger for a refused transition with sufficient payments: a test order process that
// refuses one target state while `refuseTo` names it, as a merchant's own process could.
let refuseTo: OrderState | undefined;
const refusingProcess: OrderProcess<OrderState> = {
  onTransitionStart: (_from, to) => (to === refuseTo ? `Test process refuses ${to}` : undefined),
};

describe('error classes (ADR 0002 §2)', () => {
  const environment = createPluginTestEnvironment({ orderOptions: { process: [defaultOrderProcess, refusingProcess] } });
  const { server, adminClient, variantIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 100 }] });
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
  });
  afterAll(() => server.destroy());
  afterEach(() => {
    refuseTo = undefined;
    recipe.testObserver = undefined;
  });

  const mug = (quantity = 1) => ({ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800 });
  async function counts() {
    return {
      orders: await connection.rawConnection.getRepository(Order).count(),
      ledger: await connection.rawConnection.getRepository(TallyCommand).count(),
      lines: await connection.rawConnection.getRepository(OrderLine).count(),
      payments: await connection.rawConnection.getRepository(Payment).count(),
      stockMovements: await connection.rawConnection.getRepository(StockMovement).count(),
      surcharges: await connection.rawConnection.getRepository(Surcharge).count(),
      shippingLines: await connection.rawConnection.getRepository(ShippingLine).count(),
      customers: await connection.rawConnection.getRepository(Customer).count(),
    };
  }
  const ledgerFor = (input: CommandEnvelope) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id });
  // Asserts a stored rejection: only the ledger row is written, and a replay returns it without the recipe.
  async function expectStored(input: ReturnType<typeof orderCommand>, expected: object) {
    const before = await counts();
    const createDraft = vi.spyOn(server.app.get(OrderService), 'createDraft'); // Calls Vendure unchanged.
    try {
      const result = await run(input);
      expect(result).toEqual({ id: input.id, status: 'rejected', error: expected });
      expect(await counts()).toEqual({ ...before, ledger: before.ledger + 1 });
      expect(await ledgerFor(input)).toMatchObject({ status: 'rejected', result });
      expect(await run(input)).toEqual(result);
      expect(createDraft).toHaveBeenCalledTimes(1);
      return result;
    } finally {
      createDraft.mockRestore();
    }
  }

  it('a real underpayment: the refused PaymentSettled transition with payments below the total is `underpaid`', async () => {
    const input = orderCommand([mug()], [{ method: 'cash', amountMinor: 400 }]);
    await expectStored(input, { code: 'underpaid', message: 'Payments of 400 are below the total of 1000' });
  });

  it('a refused PaymentSettled transition with sufficient payments is platform_error, with the platform code and message in data', async () => {
    refuseTo = 'PaymentSettled';
    const input = orderCommand([mug()], [{ method: 'cash', amountMinor: 1000 }]);
    const result = await expectStored(input, {
      code: 'platform_error', message: expect.any(String),
      data: { platformCode: 'ORDER_STATE_TRANSITION_ERROR', platformMessage: 'ORDER_STATE_TRANSITION_ERROR' },
    });
    expect(JSON.parse(result.error!.message.replace(/^ORDER_STATE_TRANSITION_ERROR: /, ''))).toEqual({
      transitionError: 'Test process refuses PaymentSettled', fromState: 'ArrangingPayment', toState: 'PaymentSettled',
    });
  });

  it('review 13: a refused PaymentSettled with enough payment and a store fault is store_configuration, not stored', async () => {
    refuseTo = 'PaymentSettled';
    const input = orderCommand([mug()], [{ method: 'cash', amountMinor: 1000 }]);
    const channel = await connection.rawConnection.getRepository(Channel).findOneOrFail({
      where: { code: '__default_channel__' }, relations: ['defaultTaxZone'],
    });
    const rates = connection.rawConnection.getRepository(TaxRate);
    const enabled = await rates.find({ where: { zoneId: channel.defaultTaxZone.id, enabled: true } });
    // The store breaks while the sale is being recorded, after the pre-claim check passed.
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage !== 'payments' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      for (const rate of enabled) await rates.update(rate.id, { enabled: false });
    };
    const before = await counts();
    try {
      expect(await run(input)).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'store_configuration' } });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
    } finally {
      for (const rate of enabled) await rates.update(rate.id, { enabled: true });
    }
    // Not stored: once the store is repaired and the process accepts, the same id applies.
    recipe.testObserver = undefined;
    refuseTo = undefined;
    expect(await run(input)).toMatchObject({ id: input.id, status: 'applied' });
  });

  it('ruling 3: a shortage createFulfillment finds (INSUFFICIENT_STOCK_ON_HAND_ERROR) maps to insufficient_stock', () => {
    const rejection = rejectionFor(new InsufficientStockOnHandError({
      productVariantId: 'T_3', productVariantName: 'Print', stockOnHand: 2,
    }));
    expect(rejection).toMatchObject({ code: 'insufficient_stock', data: undefined });
    expect(rejection.message).toBe('INSUFFICIENT_STOCK_ON_HAND_ERROR: {"productVariantId":"T_3","productVariantName":"Print","stockOnHand":2}');
    expect(UNKNOWN_REJECTION_CODE).toBe('platform_error');
  });

  it('an unknown ErrorResult (OrderLimitError from addItemToOrder) is a stored platform_error with its code and replays', async () => {
    const options = server.app.get(ConfigService).orderOptions;
    const limit = options.orderItemsLimit;
    options.orderItemsLimit = 1;
    try {
      await expectStored(orderCommand([mug(2)]), {
        code: 'platform_error', message: expect.any(String),
        data: { platformCode: 'ORDER_LIMIT_ERROR', platformMessage: expect.any(String) },
      });
    } finally {
      options.orderItemsLimit = limit;
    }
  });

  it('InsufficientStockError that survives the top-up is a stored `insufficient_stock`', async () => {
    // Test-only: the recipe's own saleable check (its first call) sees plenty, so it skips the top-up
    // for Print (2 on hand); Vendure's own check inside addItemToOrder then sees the real 2.
    const saleable = vi.spyOn(server.app.get(ProductVariantService), 'getSaleableStockLevel').mockResolvedValueOnce(1000);
    try {
      await expectStored(orderCommand([{ variantId: variantIds.print[0], quantity: 3, unitPriceMinor: 4500 }]), {
        code: 'insufficient_stock', message: 'INSUFFICIENT_STOCK_ERROR: {"quantityAvailable":2}',
      });
    } finally {
      saleable.mockRestore();
    }
  });

  it('platform_error leaves no durable change; a Retry under a new id with the same clientOrderId makes exactly one order', async () => {
    // The till requeues a platform_error under a NEW command id, so the rejection must leave nothing.
    refuseTo = 'PaymentSettled';
    const emailAddress = 'vp1-platform-error@example.com';
    // Before the refusal the recipe writes a new customer, a stock top-up (Print: 2 on hand), lines,
    // a discount surcharge, a shipping line and a payment, so every count below is non-vacuous.
    const lines = [{ variantId: variantIds.print[0], quantity: 3, unitPriceMinor: 4500, discountMinor: 100 }];
    const input = orderCommand(lines, undefined, { email: emailAddress });
    let written: Record<string, number> = {};
    const baseline = await counts();
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage !== 'payments' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      const ofOrder = { where: { order: { id: order.id } } };
      written = {
        lines: await connection.getRepository(ctx, OrderLine).count(ofOrder),
        payments: await connection.getRepository(ctx, Payment).count(ofOrder),
        surcharges: await connection.getRepository(ctx, Surcharge).count(ofOrder),
        shippingLines: await connection.getRepository(ctx, ShippingLine).count(ofOrder),
        stockMovements: await connection.getRepository(ctx, StockMovement).count() - baseline.stockMovements,
        customers: await connection.getRepository(ctx, Customer).count({ where: { emailAddress } }),
      };
    };
    const result = await expectStored(input, {
      code: 'platform_error', message: expect.any(String),
      data: { platformCode: 'ORDER_STATE_TRANSITION_ERROR', platformMessage: 'ORDER_STATE_TRANSITION_ERROR' },
    });
    expect(written).toEqual({ lines: 1, payments: 1, surcharges: 1, shippingLines: 1, stockMovements: 1, customers: 1 });
    // (a) Only the ledger row survives: no order, line, payment, surcharge, shipping line, stock movement or customer.
    expect(await counts()).toEqual({ ...baseline, ledger: baseline.ledger + 1 });
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress } })).toBe(0);

    // (b) The till's Retry: a new command id, the same sale. It applies once...
    refuseTo = undefined;
    recipe.testObserver = undefined;
    const retry = { ...input, id: orderCommand(lines).id };
    const applied = await run(retry);
    expect(applied, JSON.stringify(applied)).toMatchObject({ id: retry.id, status: 'applied' });
    const ordersFor = () => connection.rawConnection.getRepository(Order).count({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    expect(await ordersFor()).toBe(1);
    // ...and the clientOrderId requeue path answers a further Retry with the same order, writing nothing.
    const afterRetry = await counts();
    const again = { ...input, id: orderCommand(lines).id };
    expect(await run(again)).toEqual({ id: again.id, status: 'applied', serverRefs: applied.serverRefs });
    expect(await counts()).toEqual(afterRetry);
    expect(await ordersFor()).toBe(1);
    // The rejected command id itself still replays its stored answer.
    expect(await run(input)).toEqual(result);
  });

  it('a unique-violation race on tallyClientOrderId takes the requeue path: applied with the first order\'s refs, one order, nothing written', async () => {
    // A new buyer, so neither command waits on the other's customer row, only on the unique key.
    const first = orderCommand([mug()], undefined, { email: 'vp1-race@example.com' });
    const second = { ...first, id: orderCommand([mug()]).id };
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    recipe.testObserver = async (stage, ctx) => {
      // Hold only the first command, after its order row carries the clientOrderId.
      const claimed = await connection.getRepository(ctx, TallyCommand).findOneBy({ id: first.id });
      if (stage === 'addItemToOrder' && claimed) {
        entered();
        await released;
      }
    };
    const a = run(first);
    await reached;
    const b = run(second);
    // Wait until the second command's order update blocks on the first's uncommitted unique key.
    const start = performance.now();
    let blocked: string[] = [];
    while (!blocked.length && performance.now() - start < 10_000) {
      const rows = await connection.rawConnection.query(`SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`);
      blocked = rows.map((row: { query: string }) => row.query);
      if (!blocked.length) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatch(/^UPDATE "order" SET .*"customFieldsTallyclientorderid"/);
    const before = await counts();
    release();
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toMatchObject({ id: first.id, status: 'applied' });
    expect(resultB).toEqual({ id: second.id, status: 'applied', serverRefs: resultA.serverRefs });
    expect(await connection.rawConnection.getRepository(Order).count({
      where: { customFields: { tallyClientOrderId: first.payload.clientOrderId } },
    })).toBe(1);
    expect(await ledgerFor(second)).toBeNull();
    // Taken while the first was held: only its order and ledger row commit; the second leaves nothing.
    const after = await counts();
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.orders).toBe(before.orders + 1);
  });

  it('unsupported_currency is refused before the claim with no ledger row; the same id applies once the channel offers it', async () => {
    const input = orderCommand([mug()]);
    input.payload.currency = 'USD';
    input.payload.display!.currency = 'USD';
    const before = await counts();
    expect(await run(input)).toEqual({ id: input.id, status: 'rejected', error: {
      code: 'unsupported_currency', message: 'The channel does not offer USD',
    } });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    await adminClient.query(parse(`mutation Currencies($id: ID!) {
      updateChannel(input: { id: $id, availableCurrencyCodes: [EUR, USD] }) { ... on Channel { id } }
    }`), { id: activeChannel.id });
    const result = await run(input);
    expect(result, JSON.stringify(result)).toMatchObject({ id: input.id, status: 'applied' });
    const order = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: decode(result.serverRefs!.orderId) });
    expect(order.currencyCode).toBe('USD');
    expect(order.totalWithTax).toBe(1000);
  });

  it('classifies only connection, lock and timeout failures as transient', () => {
    const driver = (code: string) => ({ driverError: { code } });
    // Ruling 4: a deadlock or a serialization failure is a lock failure too, and succeeds on retry.
    for (const code of ['55P03', '40P01', '40001']) expect(transientKind(driver(code)), code).toBe('lock');
    expect(transientKind(driver('57014'))).toBe('timeout');
    expect(transientKind(driver('25P03'))).toBe('timeout');
    for (const code of ['08006', '08001', '57P01', '57P03']) expect(transientKind(driver(code))).toBe('connection');
    expect(transientKind(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe('connection');
    expect(transientKind(new Error('Connection terminated unexpectedly'))).toBe('connection');
    // Review 11: 08P01 protocol_violation is deterministic, so it is not a connection failure.
    for (const code of ['23505', '23503', '22P02', '42P01', '08P01']) expect(transientKind(driver(code)), code).toBeUndefined();
    expect(transientKind(new Error('injected'))).toBeUndefined();
    expect(new TransientCommandError('id', 'lock', undefined)).toMatchObject({ commandId: 'id', kind: 'lock' });
  });
});
