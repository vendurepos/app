import {
  Customer, Order, OrderLine, OrderService, Payment, PaymentService,
  Sale, ShippingLine, StockLevel, StockMovement, Surcharge, TransactionalConnection,
} from '@vendure/core';
import { OrderHistoryEntry } from '@vendure/core/dist/entity/history-entry/order-history-entry.entity';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyCommand } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { commandFingerprint } from '../src/vendored/fingerprint';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('order.create recipe through OrderCreateService', () => {
  const environment = createPluginTestEnvironment();
  const { server, variantIds, serviceIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  const mug = () => ({ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 });
  async function submit(command: ReturnType<typeof orderCommand>) {
    expect(payloadShapeErrors(command.payload)).toEqual([]);
    expect(fiscalFiguresErrors(command.payload)).toEqual([]);
    return run(command);
  }
  async function applied(command: ReturnType<typeof orderCommand>) {
    const result = await submit(command);
    expect(result, JSON.stringify(result)).toMatchObject({ id: command.id, status: 'applied' });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) },
      relations: ['lines', 'payments', 'customer', 'shippingLines', 'shippingLines.shippingMethod', 'fulfillments'],
    });
    expect(result.serverRefs).toEqual({
      orderId: encode(order.id), displayId: order.code, totalMinor: command.payload.totalMinor,
    });
    expect(order.totalWithTax).toBe(command.payload.totalMinor);
    return { order, result };
  }
  async function counts() {
    return {
      orders: await connection.rawConnection.getRepository(Order).count(),
      orderLines: await connection.rawConnection.getRepository(OrderLine).count(),
      commands: await connection.rawConnection.getRepository(TallyCommand).count(),
      payments: await connection.rawConnection.getRepository(Payment).count(),
      stockMovements: await connection.rawConnection.getRepository(StockMovement).count(),
    };
  }
  // Proof 5 also counts the other tables the recipe writes before the failing transition.
  async function rollbackCounts() {
    return {
      ...await counts(),
      surcharges: await connection.rawConnection.getRepository(Surcharge).count(),
      shippingLines: await connection.rawConnection.getRepository(ShippingLine).count(),
      orderHistory: await connection.rawConnection.getRepository(OrderHistoryEntry).count(),
      customers: await connection.rawConnection.getRepository(Customer).count(),
    };
  }
  async function stock(variantId: string) {
    const levels = await connection.rawConnection.getRepository(StockLevel).find({ where: { productVariantId: variantId } });
    return levels.reduce((sum, level) => sum + level.stockOnHand, 0);
  }

  it('refuses malformed envelopes, invalid payloads and unsupported versions writing no sale', async () => {
    const before = await counts();
    const command = orderCommand([mug()]);
    const invalid = [
      { ...command, attempt: 0 }, { ...command, deviceId: null }, { ...command, type: 'wrong' },
      { ...command, payload: null },
      { ...command, payload: { ...command.payload, lines: [] } },
      { ...command, payload: { ...command.payload, display: { ...command.payload.display, totalMinor: 1 } } },
      { ...command, version: 6 },
    ];
    const results = [];
    for (const item of invalid) results.push(await run(item as unknown as CommandEnvelope<OrderCreatePayload>));
    expect(results.map(result => [result.status, result.error?.code])).toEqual([
      ...Array(6).fill(['rejected', 'invalid_payload']), ['rejected', 'unsupported_version'],
    ]);
    expect(results.at(-1)!.error!.data).toEqual({ orderCreate: 4 });
    expect(await counts()).toEqual(before);
  });

  it('happy path: Mug x1 + Beans(500) x2 is Delivered, priced, backdated and records SALE movements', async () => {
    const before = [await stock(serviceIds.mug[0]), await stock(serviceIds.beans[0])];
    const command = orderCommand([mug(), { variantId: variantIds.beans[0], quantity: 2, unitPriceMinor: 500 }]);
    const { order, result } = await applied(command);
    expect(order.state).toBe('Delivered');
    expect(order.currencyCode).toBe('EUR');
    expect(order.customFields).toMatchObject({
      tallyClientOrderId: command.payload.clientOrderId,
      tallySaleAt: new Date(command.payload.createdAt),
      tallyRegisterId: command.payload.registerId,
      tallySessionId: command.payload.sessionId,
      tallyCashierRef: command.payload.cashierRef,
    });
    expect(order.orderPlacedAt).toEqual(order.customFields.tallySaleAt);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
    expect(JSON.parse(order.customFields.tallySnapshot!)).toEqual({
      display: command.payload.display, taxByRate: command.payload.taxByRate,
    });
    expect(order.customer!.emailAddress).toBe('walk-in@vendurepos.invalid');
    expect(order.lines).toHaveLength(2);
    for (const posLine of command.payload.lines) {
      const line = order.lines.find(line => line.customFields.tallyClientLineId === posLine.clientLineId)!;
      expect(line.customFields).toMatchObject({
        tallyClientLineId: posLine.clientLineId, tallyUnitPrice: posLine.unitPriceMinor, tallyPriceIncludesTax: false,
      });
      expect(line.quantity).toBe(posLine.quantity);
      const sales = await connection.rawConnection.getRepository(Sale).find({ where: { orderLine: { id: line.id } } });
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ type: 'SALE', quantity: -posLine.quantity });
    }
    expect(order.shippingLines).toHaveLength(1);
    expect(order.shippingLines[0].shippingMethod.code).toBe('tally-in-store');
    expect(order.shippingWithTax).toBe(0);
    expect(order.fulfillments.map(item => item.state)).toEqual(['Delivered']);
    expect(order.payments.map(payment => [payment.state, payment.amount])).toEqual([['Settled', 2250]]);
    const ledger = await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: command.id });
    expect(ledger).toMatchObject({ status: 'applied', result, fingerprint: commandFingerprint(command) });
    expect([await stock(serviceIds.mug[0]), await stock(serviceIds.beans[0])]).toEqual([before[0] - 1, before[1] - 2]);
  });

  it('uses each line tax mode: inclusive Mug beside exclusive Beans lines', async () => {
    const command = orderCommand([
      { ...mug(), unitPriceMinor: 1000, taxInclusive: true },
      { variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500 },
      { variantId: variantIds.beans[1], quantity: 1, unitPriceMinor: 900 },
    ]);
    const { order } = await applied(command);
    const prices = command.payload.lines.map(posLine => {
      const line = order.lines.find(line => line.customFields.tallyClientLineId === posLine.clientLineId)!;
      return { inclusive: line.customFields.tallyPriceIncludesTax, unitPrice: line.unitPrice, unitPriceWithTax: line.unitPriceWithTax };
    });
    expect(prices).toEqual([
      { inclusive: true, unitPrice: 800, unitPriceWithTax: 1000 },
      { inclusive: false, unitPrice: 500, unitPriceWithTax: 625 },
      { inclusive: false, unitPrice: 900, unitPriceWithTax: 1125 },
    ]);
    expect(order.totalWithTax).toBe(2750);
  });

  it('proof 8: identical Mug variants retain two POS line identities', async () => {
    const command = orderCommand([mug(), mug()]);
    const { order } = await applied(command);
    expect(order.lines).toHaveLength(2);
    expect(order.lines.map(line => line.customFields.tallyClientLineId).sort())
      .toEqual(command.payload.lines.map(line => line.clientLineId).sort());
    expect(order.lines.map(line => line.quantity)).toEqual([1, 1]);
  });

  it('proof 9: split cash 500 and external remainder settle exactly', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 500 }, { method: 'external', amountMinor: 500 }]);
    const { order } = await applied(command);
    const payments = [...order.payments].sort((a, b) => Number(a.id) - Number(b.id));
    expect(payments.map(payment => payment.amount)).toEqual([500, 500]);
    expect(payments.map(payment => payment.state)).toEqual(['Settled', 'Settled']);
    expect(payments.map(payment => payment.metadata.tender)).toEqual(command.payload.payments);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
  });

  it('proof 9: cash tendered 2000 with change 1000 applies 1000, and tallyPayments keeps tendered and change', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 1000, tenderedMinor: 2000, changeMinor: 1000 }]);
    const { order } = await applied(command);
    expect(order.payments.map(payment => payment.amount)).toEqual([1000]);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
  });

  it('ADR-039 overpayment: with Σ amountMinor 2000 above the total 1000, the covering payment is capped at 1000', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 2000, tenderedMinor: 2000, changeMinor: 1000 }]);
    const { order } = await applied(command);
    expect(order.payments.map(payment => payment.amount)).toEqual([1000]);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
  });

  it('ADR-039: a tender after the covering one creates no Vendure payment; tallyPayments keeps both', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 1000 }, { method: 'external', amountMinor: 500 }]);
    const { order } = await applied(command);
    expect(order.totalWithTax).toBe(1000);
    expect(order.payments.map(payment => [payment.state, payment.amount])).toEqual([['Settled', 1000]]);
    expect(order.payments[0].metadata.tender).toEqual(command.payload.payments[0]);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
    expect(order.state).toBe('Delivered');
  });

  it('split tender with change on a non-final tender: payments cover the order exactly; tallyPayments as given', async () => {
    // Ruling 7 (TallyUI ADR-038): amountMinor is what the tender applies to the order, net of change.
    // Total 1000: cash 600 handed over with 100 change applies 500, then 500 by card.
    const tenders = [
      { method: 'cash' as const, amountMinor: 500, tenderedMinor: 600, changeMinor: 100 },
      { method: 'external' as const, amountMinor: 500, reference: 'card-1' },
    ];
    const command = orderCommand([mug()], tenders);
    const { order } = await applied(command);
    const payments = [...order.payments].sort((a, b) => Number(a.id) - Number(b.id));
    expect(order.totalWithTax).toBe(1000);
    expect(payments.map(payment => [payment.metadata.tender.method, payment.amount, payment.state]))
      .toEqual([['cash', 500, 'Settled'], ['external', 500, 'Settled']]);
    const stored = JSON.parse(order.customFields.tallyPayments!);
    expect(stored).toEqual(command.payload.payments);
    expect(stored[0]).toMatchObject({ amountMinor: 500, tenderedMinor: 600, changeMinor: 100 });
    expect(order.state).toBe('Delivered');
  });

  it('review 2: variant ids arrive as the Admin API gives them; a non-numeric or garbage id is a stored unknown_variant', async () => {
    expect(variantIds.mug[0]).toMatch(/^T_\d+$/);
    for (const variantId of ['T_abc', 'garbage', `T_${serviceIds.mug[0]}x`, serviceIds.mug[0], 'T_99999999999']) {
      const command = orderCommand([{ ...mug(), variantId }]);
      const result = await submit(command);
      expect(result, variantId).toMatchObject({ status: 'rejected', error: { code: 'unknown_variant' } });
    }
  });

  it('review 3: out-of-range values are invalid_payload, writing no sale', async () => {
    const before = await counts();
    const long = 'x'.repeat(256);
    const cases: Array<[string, (payload: OrderCreatePayload) => void]> = [
      ['negative unitPriceMinor', payload => { payload.lines[0].unitPriceMinor = -1; }],
      ['fractional unitPriceMinor', payload => { payload.lines[0].unitPriceMinor = 1.5; }],
      ['unsafe totalMinor', payload => { payload.totalMinor = Number.MAX_SAFE_INTEGER + 1; }],
      ['negative subtotalMinor', payload => { payload.subtotalMinor = -1; }],
      ['negative taxMinor', payload => { payload.taxMinor = -1; }],
      ['negative discountMinor', payload => { payload.lines[0].discountMinor = -5; }],
      ['negative amountMinor', payload => { payload.payments[0].amountMinor = -1; }],
      ['negative tenderedMinor', payload => { payload.payments[0].tenderedMinor = -1; }],
      ['fractional changeMinor', payload => { payload.payments[0].changeMinor = 0.5; }],
      ['unitPriceMinor above int4', payload => { payload.lines[0].unitPriceMinor = 2_147_483_648; }],
      // N2: the default MoneyStrategy's columns are int4.
      ['totalMinor above int4', payload => { payload.totalMinor = 2_147_483_648; }],
      ['amountMinor above int4', payload => { payload.payments[0].amountMinor = 2_147_483_648; }],
      ['unsafe tenderedMinor', payload => { payload.payments[0].tenderedMinor = Number.MAX_SAFE_INTEGER + 1; }],
      // N3: OrderLine.quantity is int4, and createdAt becomes tallySaleAt and orderPlacedAt.
      ['unparseable createdAt', payload => { payload.createdAt = 'yesterday-ish'; }],
      ['empty createdAt', payload => { payload.createdAt = ''; }],
      // The v3 fiscal figures carry the shared contract's safe-integer bound.
      ['unsafe display line amount', payload => { payload.display!.lines[0].amountMinor = Number.MAX_SAFE_INTEGER + 1; }],
      ['unsafe taxByRate netMinor', payload => { payload.taxByRate![0].netMinor = Number.MAX_SAFE_INTEGER + 1; }],
      ...(['clientOrderId', 'registerId', 'cashierRef'] as const).map(field =>
        [`${field} over 255`, (payload: OrderCreatePayload) => { payload[field] = long; }] as [string, (payload: OrderCreatePayload) => void]),
      ['sessionId over 36', payload => { payload.sessionId = 'x'.repeat(37); }],
      ['clientLineId over 255', payload => { payload.lines[0].clientLineId = long; }],
      ['clientPaymentId over 255', payload => { payload.payments[0].clientPaymentId = long; }],
      ['reference over 255', payload => { payload.payments[0].reference = long; }],
    ];
    for (const [name, mutate] of cases) {
      const command = orderCommand([mug()]);
      mutate(command.payload);
      const result = await run(command);
      expect(result, name).toMatchObject({ id: command.id, status: 'rejected', error: { code: 'invalid_payload' } });
    }
    expect(await counts()).toEqual(before);
    // N2: tenderedMinor and changeMinor are stored only in the tallyPayments text, so any safe integer applies.
    const tendered = orderCommand([mug()], [{
      method: 'cash', amountMinor: 1000, tenderedMinor: Number.MAX_SAFE_INTEGER, changeMinor: Number.MAX_SAFE_INTEGER - 1000,
    }]);
    const { order } = await applied(tendered);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(tendered.payload.payments);
    // The v3 display and taxByRate figures are stored as text: above int4, they apply unchanged.
    const figures = orderCommand([mug()]);
    figures.payload.display!.subtotalMinor = 2_147_483_648;
    figures.payload.taxByRate![0].netMinor += 2_147_483_648;
    figures.payload.taxByRate![0].grossMinor += 2_147_483_648;
    const snapshot = (await applied(figures)).order.customFields.tallySnapshot!;
    expect(JSON.parse(snapshot)).toEqual({ display: figures.payload.display, taxByRate: figures.payload.taxByRate });
    // A valid ISO date with an offset is a createdAt like any other.
    const offset = orderCommand([mug()]);
    offset.payload.createdAt = '2026-09-28T12:00:00+02:00';
    expect((await applied(offset)).order.customFields.tallySaleAt).toEqual(new Date('2026-09-28T10:00:00.000Z'));
  });

  it('audit 4.7b: an order discountMinor that is not the lines\' sum is an unstored invalid_payload', async () => {
    // v2, so ruling 17 knows discountMinor at both levels and only the vendored sum check refuses it.
    const command = orderCommand([{ ...mug(), discountMinor: 100 }], undefined, undefined, { version: 2 });
    command.payload.discountMinor = 101;
    const before = await counts();
    expect(await run(command)).toMatchObject({
      id: command.id, status: 'rejected',
      error: { code: 'invalid_payload', message: 'discountMinor: expected the sum of lines[].discountMinor' },
    });
    expect(await counts()).toEqual(before);
  });

  it('proof 9: zero-total sale reaches PaymentSettled without a payment, then is Delivered', async () => {
    const command = orderCommand([{ ...mug(), unitPriceMinor: 0 }], []);
    const { order } = await applied(command);
    const history = await connection.rawConnection.getRepository(OrderHistoryEntry).find({ where: { order: { id: order.id } } });
    const transitions = history.filter(entry => entry.type === 'ORDER_STATE_TRANSITION').map(entry => entry.data);
    expect(transitions).toContainEqual({ from: 'ArrangingPayment', to: 'PaymentSettled' });
    expect(order.payments).toEqual([]);
    expect(order.state).toBe('Delivered');
    expect(order.totalWithTax).toBe(0);
  });

  it('proof 5, re-ruling 4: an underpaid sale is stored on the claim: no order, line, payment, stock movement, surcharge, shipping line, history or customer', async () => {
    const before = await rollbackCounts();
    const stockBefore = await stock(serviceIds.mug[0]);
    // These spies call Vendure unchanged: no mock implementation or synthetic ErrorResult.
    const transition = vi.spyOn(server.app.get(OrderService), 'transitionToState');
    const payment = vi.spyOn(server.app.get(PaymentService), 'createPayment');
    try {
      // A discounted sale by a new buyer, which after the claim would write a surcharge and a customer.
      const command = orderCommand([{ ...mug(), discountMinor: 100 }], [{ method: 'cash', amountMinor: 500 }],
        { email: 'vp1-proof5-rollback@example.com' });
      const result = await submit(command);
      expect(result).toEqual({ id: command.id, status: 'rejected', error: {
        code: 'underpaid', message: 'Payments of 500 are below the total of 875',
      } });
      expect(transition).not.toHaveBeenCalled();
      expect(payment).not.toHaveBeenCalled();
      expect(await rollbackCounts()).toEqual({ ...before, commands: before.commands + 1 });
      expect(await connection.rawConnection.getRepository(TallyCommand).count({ where: { id: command.id } })).toBe(1);
      expect(await stock(serviceIds.mug[0])).toBe(stockBefore);
    } finally {
      transition.mockRestore();
      payment.mockRestore();
    }
  });

  it('reuses the walk-in customer and resolves a customer id before email, with unknown-id email fallback', async () => {
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: 'walk-in@vendurepos.invalid' } })).toBe(1);
    const line = { variantId: variantIds.beans[1], quantity: 1, unitPriceMinor: 900 };
    const first = await applied(orderCommand([line], undefined, { customerId: '999999', email: 'vp1-buyer@example.com' }));
    const second = await applied(orderCommand([line], undefined, { customerId: encode(first.order.customer!.id), email: 'unused@example.com' }));
    const third = await applied(orderCommand([line], undefined, { email: 'vp1-buyer@example.com' }));
    // Review 2: a garbage customer id falls back to the email, like an unknown one.
    const fourth = await applied(orderCommand([line], undefined, { customerId: 'T_not-an-id', email: 'vp1-buyer@example.com' }));
    expect(first.order.customer!.emailAddress).toBe('vp1-buyer@example.com');
    expect(second.order.customer!.id).toBe(first.order.customer!.id);
    expect(third.order.customer!.id).toBe(first.order.customer!.id);
    expect(fourth.order.customer!.id).toBe(first.order.customer!.id);
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: 'unused@example.com' } })).toBe(0);
  });
});
