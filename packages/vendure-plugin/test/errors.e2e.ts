import {
  Channel, ConfigService, Customer, EventBus, Logger, Order, OrderLine, OrderService,
  Payment, PaymentMethod, ShippingMethod,
  ProductVariantService, ShippingLine, StockMovement, Surcharge, TaxRate, TransactionalConnection, defaultOrderProcess,
} from '@vendure/core';
import type { OrderProcess, OrderState } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TransientCommandError } from '../src';
import * as bridgeBound from '../src/service/bridge-bound';
import { transientKind } from '../src/service/errors';
import type { CommandEnvelope } from '../src/vendored/commands';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
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
  // Offsets the till's total by `offset` minor units, as order-refund.e2e.ts's sellBridged does.
  function offsetBy(command: ReturnType<typeof orderCommand>, offset: number) {
    command.payload.totalMinor += offset;
    command.payload.subtotalMinor += offset;
    if (command.payload.display) {
      command.payload.display.totalMinor += offset;
      command.payload.display.subtotalMinor += offset;
      command.payload.display.lines.at(-1)!.amountMinor += offset;
    }
    command.payload.payments[0].amountMinor += offset;
    return command;
  }
  function shiftTaxBy(command: ReturnType<typeof orderCommand>, n: number) {
    const { payload } = command;
    payload.taxMinor += n;
    payload.totalMinor += n;
    payload.display!.taxMinor += n;
    payload.display!.totalMinor += n;
    payload.taxByRate![0].taxMinor += n;
    payload.taxByRate![0].grossMinor += n;
    payload.payments[0].amountMinor += n;
    return command;
  }
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

  it('TallyUI #219: every deterministic refusal is answered before the recipe writes anything, per-sale facts stored and setup not: no event at all', async () => {
    const config = server.app.get(ConfigService);
    const delivered: string[] = [];
    const subscription = server.app.get(EventBus).filter(() => true).subscribe(event => delivered.push(event.constructor.name));
    const methods = { payment: connection.rawConnection.getRepository(PaymentMethod), shipping: connection.rawConnection.getRepository(ShippingMethod) };
    const payment = await methods.payment.findOneByOrFail({ code: 'tally-pos' });
    const shipping = await methods.shipping.findOneByOrFail({ code: 'tally-in-store' });
    const foreign = { code: 'default-shipping-eligibility-checker', args: [{ name: 'orderMinimum', value: '0' }] };
    const handlers = config.shippingOptions.fulfillmentHandlers;
    const limits = { ...config.orderOptions };
    const cases: Array<[string, ReturnType<typeof orderCommand>, object, () => Promise<unknown>, () => Promise<unknown>]> = [
      ['underpaid', orderCommand([mug()], [{ method: 'cash', amountMinor: 400 }]),
        { code: 'underpaid', message: 'Payments of 400 are below the total of 1000' }, async () => {}, async () => {}],
      ['unknown_variant', orderCommand([{ variantId: 'T_999999', quantity: 1, unitPriceMinor: 800 }]),
        { code: 'unknown_variant', message: 'Variant T_999999 is missing or disabled' }, async () => {}, async () => {}],
      ['orderItemsLimit', orderCommand([mug(2)]), { code: 'store_configuration' },
        async () => { config.orderOptions.orderItemsLimit = 1; }, async () => { config.orderOptions.orderItemsLimit = limits.orderItemsLimit; }],
      ['orderLineItemsLimit', orderCommand([mug(2)]), { code: 'store_configuration' },
        async () => { config.orderOptions.orderLineItemsLimit = 1; }, async () => { config.orderOptions.orderLineItemsLimit = limits.orderLineItemsLimit; }],
      ['no manual fulfilment handler', orderCommand([mug()]), { code: 'store_configuration' },
        async () => { config.shippingOptions.fulfillmentHandlers = handlers.filter(handler => handler.code !== 'manual-fulfillment'); },
        async () => { config.shippingOptions.fulfillmentHandlers = handlers; }],
      ['a replaced payment checker', orderCommand([mug()]), { code: 'store_configuration' },
        () => methods.payment.update(payment.id, { checker: foreign }), () => methods.payment.update(payment.id, { checker: payment.checker })],
      ['a replaced shipping checker', orderCommand([mug()]), { code: 'store_configuration' },
        () => methods.shipping.update(shipping.id, { checker: foreign }), () => methods.shipping.update(shipping.id, { checker: shipping.checker })],
    ];
    const createDraft = vi.spyOn(server.app.get(OrderService), 'createDraft'); // Calls Vendure unchanged.
    try {
      for (const [name, input, error, breakStore, repair] of cases) {
        const before = await counts();
        await breakStore();
        try {
          expect(await run(input), name).toMatchObject({ id: input.id, status: 'rejected', error });
        } finally {
          await repair();
        }
        // TallyUI #219: per-sale facts are stored on the claim; store-wide setup rolls the claim back.
        const stored = (error as { code: string }).code !== 'store_configuration';
        expect(await counts(), name).toEqual({ ...before, ledger: before.ledger + (stored ? 1 : 0) });
        if (stored) expect(await ledgerFor(input), name).toMatchObject({ status: 'rejected', result: { error } });
        else expect(await ledgerFor(input), name).toBeNull();
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(createDraft).not.toHaveBeenCalled();
      expect(delivered).toEqual([]);
      // Not vacuous: an applied sale's events arrive through the same subscription.
      expect(await run(orderCommand([mug()]))).toMatchObject({ status: 'applied' });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(delivered).toContain('OrderPlacedEvent');
    } finally {
      createDraft.mockRestore();
      subscription.unsubscribe();
    }
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

  // Re-ruling 3: a race inside the recipe rolls everything back (its events with it) and stores nothing.
  async function expectTransientRace(input: ReturnType<typeof orderCommand>) {
    const before = await counts();
    const failed = await run(input).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TransientCommandError);
    expect(failed).toMatchObject({ commandId: input.id, kind: 'unclassified' });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
  }

  it('re-ruling 3: a limit lowered during the sale is a transient race; the resend is store_configuration, not stored, and the same id applies once the limit is raised', async () => {
    const options = server.app.get(ConfigService).orderOptions;
    const limit = options.orderItemsLimit;
    const input = orderCommand([mug(2)]);
    // The claim-time check passed; the store changes before addItemToOrder.
    const saleable = vi.spyOn(server.app.get(ProductVariantService), 'getSaleableStockLevel');
    saleable.mockImplementationOnce(async (...args) => {
      options.orderItemsLimit = 1;
      saleable.mockRestore();
      return server.app.get(ProductVariantService).getSaleableStockLevel(...args);
    });
    try {
      await expectTransientRace(input);
      // Front desk: the limits are store-wide setup, so the resend is store_configuration, not stored.
      const before = await counts();
      expect(await run(input)).toMatchObject({ status: 'rejected', error: {
        code: 'store_configuration', message: `The sale exceeds orderOptions.orderItemsLimit 1 or orderLineItemsLimit ${options.orderLineItemsLimit}`,
      } });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
    } finally {
      options.orderItemsLimit = limit;
      saleable.mockRestore();
    }
    // Once the limit is raised, the same id applies.
    expect(await run(input)).toMatchObject({ id: input.id, status: 'applied' });
  });

  it('re-ruling 3: InsufficientStockError that survives the top-up is a transient race; the retry tops up and applies', async () => {
    // Test-only: the recipe's own saleable check (its first call) sees plenty, so it skips the top-up
    // for Print (2 on hand); Vendure's own check inside addItemToOrder then sees the real 2.
    const input = orderCommand([{ variantId: variantIds.print[0], quantity: 3, unitPriceMinor: 4500 }]);
    const saleable = vi.spyOn(server.app.get(ProductVariantService), 'getSaleableStockLevel').mockResolvedValueOnce(1000);
    try {
      await expectTransientRace(input);
    } finally {
      saleable.mockRestore();
    }
    expect(await run(input)).toMatchObject({ status: 'applied', warnings: [{ code: 'insufficient_stock' }] });
  });

  it('re-ruling 3: a late race leaves no durable change and stores nothing; the resend applies once and a requeue meets the collision guard', async () => {
    // The till requeues a platform_error under a NEW command id, so the rejection must leave nothing.
    // The trigger is a late configuration race (the safety net): the manual fulfilment handler is
    // removed after the pre-claim check, so createFulfillment refuses after the order is PaymentSettled.
    const shippingOptions = server.app.get(ConfigService).shippingOptions;
    const handlers = shippingOptions.fulfillmentHandlers;
    const emailAddress = 'vp1-platform-error@example.com';
    // Before the refusal the recipe writes a new customer, a stock top-up (Print: 2 on hand), lines,
    // a discount surcharge, a shipping line and a payment, so every count below is non-vacuous.
    const lines = [{ variantId: variantIds.print[0], quantity: 3, unitPriceMinor: 4500, discountMinor: 100 }];
    const input = orderCommand(lines, undefined, { email: emailAddress });
    let written: Record<string, number> = {};
    const baseline = await counts();
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage !== 'payments' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      shippingOptions.fulfillmentHandlers = handlers.filter(handler => handler.code !== 'manual-fulfillment');
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
    try {
      // Re-ruling 3: after the recipe's first event, a race is transient and rolls everything back.
      const failed = await run(input).catch((error: unknown) => error);
      expect(failed).toMatchObject({ commandId: input.id, kind: 'unclassified', cause: { result: { errorCode: 'INVALID_FULFILLMENT_HANDLER_ERROR' } } });
    } finally {
      shippingOptions.fulfillmentHandlers = handlers;
    }
    // Stock: the top-up, and the allocation when the settled payment moves the order to PaymentSettled.
    expect(written).toEqual({ lines: 1, payments: 1, surcharges: 1, shippingLines: 1, stockMovements: 2, customers: 1 });
    // (a) Nothing survives: no ledger row, order, line, payment, surcharge, shipping line, stock movement or customer.
    expect(await counts()).toEqual(baseline);
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress } })).toBe(0);

    // (b) The till resends the same id, which applies once...
    recipe.testObserver = undefined;
    const retry = input;
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
    expect(applied.warnings).toEqual([{ code: 'insufficient_stock', variantId: variantIds.print[0], quantity: expect.any(Number) }]);
    expect(await run(again)).toEqual({ ...applied, id: again.id });
    expect(await counts()).toEqual({ ...afterRetry, ledger: afterRetry.ledger + 1 });
    expect(await ordersFor()).toBe(1);
    // The resent id itself replays as duplicate.
    expect(await run(input)).toEqual({ ...applied, status: 'duplicate' });
  });

  it('refinement 2: a unique-violation race on tallyClientOrderId takes the collision guard: the new id stored applied with the first result, one order', async () => {
    // The walk-in, an existing buyer, so the second command waits only on the unique key, never on the per-email
    // customer lock a new email takes (ruling 15).
    const first = orderCommand([mug()]);
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

  it('TallyUI #219, money P2 #4: a currency that is not the channel default is unsupported_currency, not stored; the same id applies once it is the default, and replays after the default moves back', async () => {
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
    expect(await run(input)).toEqual({ id: input.id, status: 'rejected', error: {
      code: 'unsupported_currency', message: 'The channel takes POS sales in EUR only, not USD',
    } });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
    const euro = orderCommand([mug()]);
    expect(await run(euro)).toMatchObject({ id: euro.id, status: 'applied' });
    const usdChannel = await adminClient.query<{ updateChannel: { defaultCurrencyCode: string } }>(parse(`mutation DefaultCurrency($id: ID!) {
      updateChannel(input: { id: $id, defaultCurrencyCode: USD }) { ... on Channel { id defaultCurrencyCode } }
    }`), { id: activeChannel.id });
    expect(usdChannel.updateChannel.defaultCurrencyCode).toBe('USD');
    const result = await run(input);
    expect(result, JSON.stringify(result)).toMatchObject({ id: input.id, status: 'applied' });
    const order = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: decode(result.serverRefs!.orderId) });
    expect(order.currencyCode).toBe('USD');
    expect(order.totalWithTax).toBe(1000);
    const eurChannel = await adminClient.query<{ updateChannel: { defaultCurrencyCode: string } }>(parse(`mutation DefaultCurrency($id: ID!) {
      updateChannel(input: { id: $id, defaultCurrencyCode: EUR }) { ... on Channel { id defaultCurrencyCode } }
    }`), { id: activeChannel.id });
    expect(eurChannel.updateChannel.defaultCurrencyCode).toBe('EUR');
    const afterApplied = await counts();
    expect(await run(input)).toEqual({ ...result, status: 'duplicate' });
    expect(await counts()).toEqual(afterApplied);
  });

  it('per-rate T is ⌈(payload lines + fees + shipping + discounted lines) / 2⌉', () => {
    for (const [lines, discounted, fees, shipping, expected] of [
      [1, 0, undefined, undefined, 1], [2, 0, undefined, undefined, 1], [3, 0, undefined, undefined, 2],
      [1, 1, undefined, undefined, 1], [2, 1, undefined, undefined, 2], [2, 2, undefined, undefined, 2],
      [5, 5, undefined, undefined, 5], [1, 0, 1, 1, 2], [2, 2, 2, 1, 4], [4, 0, 0, 0, 2],
    ] as const) {
      expect(bridgeBound.rateToleranceMinor({
        lines: Array.from({ length: lines }, (_, index) => ({ discountMinor: index < discounted ? 1 : 0 })),
        ...(fees === undefined ? {} : { fees: Array(fees) }),
        ...(shipping === undefined ? {} : { shipping: Array(shipping) }),
      } as never)).toBe(expected);
    }
  });

  it('per-rate T counts the payload: 1 line, a 1-cent rate shift is within T and a 2-cent one is a tax_rate_mismatch', async () => {
    const within = shiftTaxBy(orderCommand([mug()]), 1);
    expect(fiscalFiguresErrors(within.payload)).toEqual([]);
    expect(payloadShapeErrors(within.payload)).toEqual([]);
    const first = await run(within);
    expect(first.status).toBe('applied');
    expect(first.totalWarnings).toEqual([{ code: 'total_mismatch', expectedMinor: 1001, serverMinor: 1000, bridgeMinor: 1 }]);
    expect(first.warnings?.filter(warning => warning.code === 'tax_rate_mismatch') ?? []).toEqual([]);

    // Under the old count (1 line + bridge surcharge + shipping line = 3, T 2), this had no tax_rate_mismatch.
    const beyond = shiftTaxBy(orderCommand([mug()]), 2);
    expect(fiscalFiguresErrors(beyond.payload)).toEqual([]);
    expect(payloadShapeErrors(beyond.payload)).toEqual([]);
    const second = await run(beyond);
    const mismatch = { code: 'tax_rate_mismatch', ratePpm: 250000, expectedMinor: 202, serverMinor: 200 };
    expect(second.status).toBe('applied');
    expect(second.totalWarnings).toEqual([
      { code: 'total_mismatch', expectedMinor: 1002, serverMinor: 1000, bridgeMinor: 2 }, mismatch,
    ]);
    expect(second.warnings).toContainEqual(mismatch);
    expect(second.warnings).toEqual([
      { code: 'total_mismatch', expectedMinor: 1002, serverMinor: 1000, bridgeMinor: 2 }, mismatch,
    ]);
  });

  it('per-rate T counts discounted lines: 2 discounted lines, a 2-cent rate shift is within T and a 3-cent one is a tax_rate_mismatch', async () => {
    // 2 lines + 2 discounted lines: T 2. Without the discount rows (T 1), (a) would be a tax_rate_mismatch.
    const within = shiftTaxBy(orderCommand([{ ...mug(), discountMinor: 100 }, { ...mug(), discountMinor: 100 }]), 2);
    expect(fiscalFiguresErrors(within.payload)).toEqual([]);
    expect(payloadShapeErrors(within.payload)).toEqual([]);
    const first = await run(within);
    expect(first.status).toBe('applied');
    const { totalMinor } = within.payload;
    expect(first.totalWarnings).toEqual([{ code: 'total_mismatch', expectedMinor: totalMinor, serverMinor: totalMinor - 2, bridgeMinor: 2 }]);
    expect(first.warnings?.filter(warning => warning.code === 'tax_rate_mismatch') ?? []).toEqual([]);

    const beyond = shiftTaxBy(orderCommand([{ ...mug(), discountMinor: 100 }, { ...mug(), discountMinor: 100 }]), 3);
    const second = await run(beyond);
    const { taxMinor } = beyond.payload.taxByRate![0];
    expect(second.status).toBe('applied');
    expect(second.warnings).toContainEqual({ code: 'tax_rate_mismatch', ratePpm: 250000, expectedMinor: taxMinor, serverMinor: taxMinor - 3 });
  });

  it('money P3 #7: the bound is max(2, product lines + surcharges + shipping lines)', () => {
    for (const [lines, surcharges, shippingLines, expected] of [
      [1, 0, 0, 2], [0, 0, 0, 2], [1, 0, 1, 2], [2, 0, 1, 3],
      [3, 1, 1, 5], [1, 2, 0, 3], [0, 0, 3, 3],
    ]) {
      expect(bridgeBound.bridgeBoundMinor({
        lines: Array(lines), surcharges: Array(surcharges), shippingLines: Array(shippingLines),
      } as never)).toBe(expected);
    }
  });

  it('money P3 #7: a bridge at the bound applies with the total_mismatch warning; one over it is refused, not stored, no event, and the corrected resend applies', async () => {
    const atBound = offsetBy(orderCommand([mug()]), 2);
    expect(await run(atBound)).toMatchObject({ status: 'applied', totalWarnings: [
      { code: 'total_mismatch', expectedMinor: 1002, serverMinor: 1000, bridgeMinor: 2 },
    ] });
    const delivered: string[] = [];
    const subscription = server.app.get(EventBus).filter(() => true).subscribe(event => delivered.push(event.constructor.name));
    const warn = vi.spyOn(Logger, 'warn');
    try {
      const before = await counts();
      const over = offsetBy(orderCommand([mug()]), 3);
      expect(await run(over)).toEqual({ id: over.id, status: 'rejected', error: {
        code: 'total_mismatch',
        message: "The POS total 1003 differs from the server's 1000 by 3, more than the 2 allowed for rounding",
        data: { expectedMinor: 1003, serverMinor: 1000, bridgeMinor: 3, boundMinor: 2 },
      } });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(over)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      for (const part of [over.id, 'total_mismatch', `"clientOrderId":"${over.payload.clientOrderId}"`,
        '"version":3', '"expectedMinor":1003', '"serverMinor":1000', '"bridgeMinor":3', '"boundMinor":2']) {
        expect(warn.mock.calls[0][0]).toContain(part);
      }
      const under = offsetBy(orderCommand([mug()]), -3);
      expect(await run(under)).toMatchObject({ status: 'rejected', error: {
        code: 'total_mismatch', data: { expectedMinor: 997, serverMinor: 1000, bridgeMinor: -3, boundMinor: 2 },
      } });
      expect(await counts()).toEqual(before);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(delivered).toEqual([]);
      const fixed = structuredClone(over);
      offsetBy(fixed, -3);
      const result = await run(fixed);
      expect(result).toMatchObject({ id: over.id, status: 'applied' });
      expect(result.totalWarnings?.some(warning => warning.code === 'total_mismatch') ?? false).toBe(false);
    } finally {
      warn.mockRestore();
      subscription.unsubscribe();
    }
  });

  it('money P3 #7: every command version is bounded: a version 2 sale one over the bound is refused, not stored', async () => {
    const input = offsetBy(orderCommand([mug()], undefined, undefined, { version: 2 }), 3);
    const before = await counts();
    expect(await run(input)).toMatchObject({ status: 'rejected', error: { code: 'total_mismatch', data: { boundMinor: 2 } } });
    expect(await counts()).toEqual(before);
    expect(await ledgerFor(input)).toBeNull();
  });

  it('money P3 #7: a sale recorded with a bridge over the bound replays its recorded answer', async () => {
    const input = offsetBy(orderCommand([mug()]), 3);
    const bound = vi.spyOn(bridgeBound, 'bridgeBoundMinor').mockReturnValueOnce(1000);
    let applied;
    try {
      applied = await run(input);
      expect(applied).toMatchObject({ status: 'applied', totalWarnings: [{ code: 'total_mismatch', bridgeMinor: 3 }] });
    } finally {
      bound.mockRestore();
    }
    const afterApplied = await counts();
    expect(await run(structuredClone(input))).toEqual({ ...applied, status: 'duplicate' });
    expect(await counts()).toEqual(afterApplied);
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
