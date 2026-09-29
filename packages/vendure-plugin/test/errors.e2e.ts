import {
  Channel, ConfigService, Customer, EventBus, InsufficientStockOnHandError, Order, OrderLine, OrderPlacedEvent, OrderService,
  OrderStateTransitionEvent, Payment,
  ProductVariantService, ShippingLine, StockMovement, Surcharge, TaxRate, TransactionalConnection, defaultOrderProcess,
} from '@vendure/core';
import type { OrderProcess, OrderState } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, PLATFORM_ERROR_CODE, TallyCommand, TransientCommandError } from '../src';
import { classify } from '../src/service/classification';
import { ErrorResultThrown, transientKind } from '../src/service/errors';
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

  it('ruling 1: a refused PaymentSettled with sufficient payments (a state transition, off the permanent list) is transient; nothing is stored', async () => {
    refuseTo = 'PaymentSettled';
    const input = orderCommand([mug()], [{ method: 'cash', amountMinor: 1000 }]);
    const before = await counts();
    const failed = await run(input).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TransientCommandError);
    expect(failed).toMatchObject({ commandId: input.id, kind: 'unclassified', cause: { result: { errorCode: 'ORDER_STATE_TRANSITION_ERROR' } } });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    // The claim was released, so once the process accepts, the same id applies.
    refuseTo = undefined;
    expect(await run(input)).toMatchObject({ id: input.id, status: 'applied' });
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
    const verdict = classify(new ErrorResultThrown(new InsufficientStockOnHandError({
      productVariantId: 'T_3', productVariantName: 'Print', stockOnHand: 2,
    })), '');
    expect(verdict).toMatchObject({ origin: 'mapped', outcome: 'stored', rejection: { code: 'insufficient_stock', data: undefined } });
    expect(verdict.outcome === 'stored' && verdict.rejection!.message)
      .toBe('INSUFFICIENT_STOCK_ON_HAND_ERROR: {"productVariantId":"T_3","productVariantName":"Print","stockOnHand":2}');
    expect(PLATFORM_ERROR_CODE).toBe('platform_error');
  });

  it('ruling 1: a permanent ErrorResult (ORDER_LIMIT_ERROR from addItemToOrder) is a stored platform_error in the amendment\'s shape, and replays', async () => {
    const options = server.app.get(ConfigService).orderOptions;
    const limit = options.orderItemsLimit;
    options.orderItemsLimit = 1;
    try {
      const platformMessage = 'ORDER_LIMIT_ERROR: {"maxItems":1}';
      await expectStored(orderCommand([mug(2)]), {
        code: 'platform_error', message: `ORDER_LIMIT_ERROR: ${platformMessage}`,
        data: { platformCode: 'ORDER_LIMIT_ERROR', platformMessage },
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
    // The trigger is permanent and late: without the manual fulfilment handler, createFulfillment
    // refuses after the order is PaymentSettled.
    const shippingOptions = server.app.get(ConfigService).shippingOptions;
    const handlers = shippingOptions.fulfillmentHandlers;
    shippingOptions.fulfillmentHandlers = handlers.filter(handler => handler.code !== 'manual-fulfillment');
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
    let result: Awaited<ReturnType<typeof expectStored>>;
    try {
      result = await expectStored(input, {
        code: 'platform_error', message: 'INVALID_FULFILLMENT_HANDLER_ERROR: INVALID_FULFILLMENT_HANDLER_ERROR',
        data: { platformCode: 'INVALID_FULFILLMENT_HANDLER_ERROR', platformMessage: 'INVALID_FULFILLMENT_HANDLER_ERROR' },
      });
    } finally {
      shippingOptions.fulfillmentHandlers = handlers;
    }
    // Stock: the top-up, and the allocation when the settled payment moves the order to PaymentSettled.
    expect(written).toEqual({ lines: 1, payments: 1, surcharges: 1, shippingLines: 1, stockMovements: 2, customers: 1 });
    // (a) Only the ledger row survives: no order, line, payment, surcharge, shipping line, stock movement or customer.
    expect(await counts()).toEqual({ ...baseline, ledger: baseline.ledger + 1 });
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress } })).toBe(0);

    // (b) The till's Retry: a new command id, the same sale. It applies once...
    recipe.testObserver = undefined;
    const retry = { ...input, id: orderCommand(lines).id };
    const applied = await run(retry);
    expect(applied, JSON.stringify(applied)).toMatchObject({ id: retry.id, status: 'applied' });
    const ordersFor = () => connection.rawConnection.getRepository(Order).count({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    expect(await ordersFor()).toBe(1);
    // ...and the collision guard answers a further Retry with the same order, its refs and its
    // warnings, storing only the new id's applied row.
    const afterRetry = await counts();
    const again = { ...input, id: orderCommand(lines).id };
    expect(applied.warnings).toEqual([{ code: 'insufficient_stock', variantId: variantIds.print[0], quantity: 1 }]);
    expect(await run(again)).toEqual({ ...applied, id: again.id });
    expect(await counts()).toEqual({ ...afterRetry, ledger: afterRetry.ledger + 1 });
    expect(await ordersFor()).toBe(1);
    // The rejected command id itself still replays its stored answer.
    expect(await run(input)).toEqual(result);
  });

  // KNOWN GAP, reported to the Front desk: Vendure's EventBus waits only for the outer transaction,
  // so events published inside the rolled-back savepoint are still delivered when the stored
  // rejection commits. `it.fails` passes while the gap exists and fails once it is closed.
  it.fails('the amendment: no event of a rolled-back sale reaches a subscriber after its platform_error commits', async () => {
    const input = orderCommand([mug()]);
    const control = orderCommand([mug()]);
    const delivered: Record<string, string[]> = { [input.id]: [], [control.id]: [] };
    const subscription = server.app.get(EventBus).filter(event => event instanceof OrderPlacedEvent
      || event instanceof OrderStateTransitionEvent).subscribe(event => {
      const { order } = event as OrderPlacedEvent | OrderStateTransitionEvent;
      for (const command of [input, control]) {
        if (order.customFields.tallyClientOrderId === command.payload.clientOrderId) delivered[command.id].push(event.constructor.name);
      }
    });
    // The subscription is not vacuous: an applied sale's events arrive.
    expect(await run(control)).toMatchObject({ status: 'applied' });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(delivered[control.id]).toContain('OrderPlacedEvent');
    const shippingOptions = server.app.get(ConfigService).shippingOptions;
    const handlers = shippingOptions.fulfillmentHandlers;
    shippingOptions.fulfillmentHandlers = handlers.filter(handler => handler.code !== 'manual-fulfillment');
    try {
      expect(await run(input)).toMatchObject({ status: 'rejected', error: { code: 'platform_error' } });
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      shippingOptions.fulfillmentHandlers = handlers;
      subscription.unsubscribe();
    }
    expect(delivered[input.id]).toEqual([]);
  });

  it('refinement 2: a unique-violation race on tallyClientOrderId takes the collision guard: the new id stored applied with the first result, one order', async () => {
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
    expect(resultB).toEqual({ ...resultA, id: second.id });
    expect(await connection.rawConnection.getRepository(Order).count({
      where: { customFields: { tallyClientOrderId: first.payload.clientOrderId } },
    })).toBe(1);
    // The collision guard: the second id is stored as applied with the first's result, and replays as duplicate.
    expect(await ledgerFor(second)).toMatchObject({ status: 'applied', result: resultB });
    expect(await run(second)).toEqual({ ...resultB, status: 'duplicate' });
    // Taken while the first was held: one order, and the two ledger rows.
    const after = await counts();
    expect(after.ledger).toBe(before.ledger + 2);
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

  it('classifies only connection, lock, deadlock, timeout and resource failures as transient', () => {
    const driver = (code: string) => ({ driverError: { code } });
    // N5: only lock_not_available is `lock` (409 on the claim); a deadlock or a serialization failure is `deadlock` (503).
    expect(transientKind(driver('55P03'))).toBe('lock');
    for (const code of ['40P01', '40001']) expect(transientKind(driver(code)), code).toBe('deadlock');
    expect(transientKind(driver('57014'))).toBe('timeout');
    expect(transientKind(driver('25P03'))).toBe('timeout');
    // N1: 57P05 idle_session_timeout and 40003 statement_completion_unknown are connection failures.
    for (const code of ['08006', '08001', '57P01', '57P03', '57P05', '40003']) expect(transientKind(driver(code)), code).toBe('connection');
    // N1: class 53 insufficient resources, except 53400 configuration_limit_exceeded.
    for (const code of ['53000', '53100', '53200', '53300']) expect(transientKind(driver(code)), code).toBe('resources');
    expect(transientKind(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe('connection');
    expect(transientKind(new Error('Connection terminated unexpectedly'))).toBe('connection');
    // Review 11: 08P01 protocol_violation is deterministic, so it is not a connection failure.
    for (const code of ['23505', '23503', '22P02', '42P01', '08P01', '53400', '57P04']) expect(transientKind(driver(code)), code).toBeUndefined();
    expect(transientKind(new Error('injected'))).toBeUndefined();
    expect(new TransientCommandError('id', 'lock', undefined)).toMatchObject({ commandId: 'id', kind: 'lock' });
  });
});
