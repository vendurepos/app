import {
  Customer, Order, OrderLine, OrderService, Payment, PaymentService,
  Sale, ShippingLine, StockLevel, StockMovement, Surcharge, TransactionalConnection, isGraphQlErrorResult,
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
  const { server, serviceIds, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  const mug = () => ({ variantId: serviceIds.mug[0], quantity: 1, unitPriceMinor: 800 });
  async function submit(command: ReturnType<typeof orderCommand>) {
    expect(payloadShapeErrors(command.payload)).toEqual([]);
    expect(fiscalFiguresErrors(command.payload)).toEqual([]);
    return run(command);
  }
  async function applied(command: ReturnType<typeof orderCommand>) {
    const result = await submit(command);
    expect(result, JSON.stringify(result)).toMatchObject({ id: command.id, status: 'applied' });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: result.serverRefs!.orderId },
      relations: ['lines', 'payments', 'customer', 'shippingLines', 'shippingLines.shippingMethod', 'fulfillments'],
    });
    expect(result.serverRefs).toEqual({
      orderId: String(order.id), displayId: order.code, totalMinor: command.payload.totalMinor,
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

  it('refuses malformed envelopes, invalid payloads and unsupported versions before the claim, writing nothing', async () => {
    const before = await counts();
    const command = orderCommand([mug()]);
    const invalid = [
      { ...command, attempt: 0 }, { ...command, deviceId: null }, { ...command, type: 'wrong' },
      { ...command, payload: null },
      { ...command, payload: { ...command.payload, lines: [] } },
      { ...command, payload: { ...command.payload, display: { ...command.payload.display, totalMinor: 1 } } },
      { ...command, version: 4 },
    ];
    const results = [];
    for (const item of invalid) results.push(await run(item as unknown as CommandEnvelope<OrderCreatePayload>));
    expect(results.map(result => [result.status, result.error?.code])).toEqual([
      ...Array(6).fill(['rejected', 'invalid_payload']), ['rejected', 'unsupported_version'],
    ]);
    expect(results.at(-1)!.error!.data).toEqual({ orderCreate: 3 });
    expect(await counts()).toEqual(before);
  });

  it('happy path: Mug x1 + Beans(500) x2 is Delivered, priced, backdated and records SALE movements', async () => {
    const before = [await stock(serviceIds.mug[0]), await stock(serviceIds.beans[0])];
    const command = orderCommand([mug(), { variantId: serviceIds.beans[0], quantity: 2, unitPriceMinor: 500 }]);
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
      { variantId: serviceIds.beans[0], quantity: 1, unitPriceMinor: 500 },
      { variantId: serviceIds.beans[1], quantity: 1, unitPriceMinor: 900 },
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

  it('proof 9: overpayment caps the covering payment at 1000 and preserves tendered 2000/change 1000', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 2000, tenderedMinor: 2000, changeMinor: 1000 }]);
    const { order } = await applied(command);
    expect(order.payments.map(payment => payment.amount)).toEqual([1000]);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
  });

  it('split tender with change on a non-final tender: payments cover the order exactly; tallyPayments as given', async () => {
    // Total 1000: cash 600 tendered with 100 change, then 500 external. The tenders sum to 1100.
    const tenders = [
      { method: 'cash' as const, amountMinor: 600, tenderedMinor: 600, changeMinor: 100 },
      { method: 'external' as const, amountMinor: 500, reference: 'card-1' },
    ];
    const command = orderCommand([mug()], tenders);
    const { order } = await applied(command);
    const payments = [...order.payments].sort((a, b) => Number(a.id) - Number(b.id));
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(order.totalWithTax);
    expect(order.totalWithTax).toBe(1000);
    // The recipe caps only the covering tender: cash keeps its 600, the external tender covers the other 400.
    expect(payments.map(payment => [payment.metadata.tender.method, payment.amount, payment.state]))
      .toEqual([['cash', 600, 'Settled'], ['external', 400, 'Settled']]);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
    expect(order.state).toBe('Delivered');
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

  it('proof 5: an underpaid sale is a stored `underpaid`; order, lines, payments, stock movements, surcharges, shipping lines, history and customers roll back', async () => {
    const before = await rollbackCounts();
    const stockBefore = await stock(serviceIds.mug[0]);
    // These spies call Vendure unchanged: no mock implementation or synthetic ErrorResult.
    const transition = vi.spyOn(server.app.get(OrderService), 'transitionToState');
    const payment = vi.spyOn(server.app.get(PaymentService), 'createPayment');
    try {
      // The discount makes the recipe save a surcharge row before the failing transition, so the
      // surcharge count below cannot pass vacuously; a new buyer email does the same for customers.
      const command = orderCommand([{ ...mug(), discountMinor: 100 }], [{ method: 'cash', amountMinor: 500 }],
        { email: 'vp1-proof5-rollback@example.com' });
      const result = await submit(command);
      expect(result).toEqual({ id: command.id, status: 'rejected', error: {
        code: 'underpaid', message: 'Payments of 500 are below the total of 875',
      } });
      expect(transition.mock.calls.at(-1)?.[2]).toBe('PaymentSettled');
      const returned = await transition.mock.results.at(-1)!.value;
      expect(Boolean(isGraphQlErrorResult(returned))).toBe(true);
      expect(returned.__typename).toBe('OrderStateTransitionError');
      expect(payment).toHaveBeenCalledTimes(1);
      expect(await payment.mock.results[0].value).toMatchObject({ amount: 500, state: 'Settled' });
      expect(await rollbackCounts()).toEqual({ ...before, commands: before.commands + 1 });
      const ledger = await connection.rawConnection.getRepository(TallyCommand).find({ where: { id: command.id } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ status: 'rejected', result });
      expect(await stock(serviceIds.mug[0])).toBe(stockBefore);
    } finally {
      transition.mockRestore();
      payment.mockRestore();
    }
  });

  it('reuses the walk-in customer and resolves a customer id before email, with unknown-id email fallback', async () => {
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: 'walk-in@vendurepos.invalid' } })).toBe(1);
    const line = { variantId: serviceIds.beans[1], quantity: 1, unitPriceMinor: 900 };
    const first = await applied(orderCommand([line], undefined, { customerId: '999999', email: 'vp1-buyer@example.com' }));
    const second = await applied(orderCommand([line], undefined, { customerId: String(first.order.customer!.id), email: 'unused@example.com' }));
    const third = await applied(orderCommand([line], undefined, { email: 'vp1-buyer@example.com' }));
    expect(first.order.customer!.emailAddress).toBe('vp1-buyer@example.com');
    expect(second.order.customer!.id).toBe(first.order.customer!.id);
    expect(third.order.customer!.id).toBe(first.order.customer!.id);
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: 'unused@example.com' } })).toBe(0);
  });
});
