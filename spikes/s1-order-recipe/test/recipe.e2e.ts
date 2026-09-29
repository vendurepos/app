import {
  ConfigService, Customer, Order, OrderLine, OrderService, Payment, PaymentService,
  Sale, StockLevel, StockMovement, TransactionalConnection, isGraphQlErrorResult,
} from '@vendure/core';
import { OrderHistoryEntry } from '@vendure/core/dist/entity/history-entry/order-history-entry.entity';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope, CommandResult } from '../src/vendored/commands';
import { commandFingerprint } from '../src/vendored/fingerprint';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { TallyCommand } from '../src/plugin/tally-command.entity';
import { createS1TestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('S1 order.create recipe through HTTP', () => {
  const environment = createS1TestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let url: string;
  beforeAll(async () => {
    await environment.init();
    // GraphQL encodes the harness IDs; the recipe and repository use service IDs.
    const strategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
    for (const ids of Object.values(variantIds)) {
      ids.splice(0, ids.length, ...ids.map(id => String(strategy.decodeId(id))));
    }
    connection = server.app.get(TransactionalConnection);
    url = `${await server.app.getUrl()}/tally/v1/commands`;
  });
  afterAll(() => server.destroy());

  const mug = () => ({ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 });
  async function post(commands: CommandEnvelope[], protocol: string | undefined = '1', authenticated = true) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(protocol ? { 'X-Tally-Protocol': protocol } : {}),
        ...(authenticated ? { Authorization: `Bearer ${adminClient.getAuthToken()}` } : {}),
      },
      body: JSON.stringify({ commands }),
    });
  }
  async function submit(command: ReturnType<typeof orderCommand>) {
    expect(payloadShapeErrors(command.payload)).toEqual([]);
    expect(fiscalFiguresErrors(command.payload)).toEqual([]);
    const response = await post([command]);
    const body = await response.json() as { results: CommandResult[] };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.results).toHaveLength(1);
    return body.results[0];
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
  async function stock(variantId: string) {
    const levels = await connection.rawConnection.getRepository(StockLevel).find({ where: { productVariantId: variantId } });
    return levels.reduce((sum, level) => sum + level.stockOnHand, 0);
  }

  it('requires protocol 1 and CreateOrder authentication; invalid payloads and versions write nothing', async () => {
    const before = await counts();
    const command = orderCommand([mug()]);
    expect((await post([command], '')).status).toBe(400);
    expect((await post([command], '2')).status).toBe(400);
    expect((await post([command], '1', false)).status).toBe(403);
    const invalid = [
      { ...command, version: 4 },
      { ...command, payload: { ...command.payload, lines: [] } },
      { ...command, payload: { ...command.payload, display: { ...command.payload.display, totalMinor: 1 } } },
    ];
    const response = await post(invalid as CommandEnvelope[]);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results.map((result: CommandResult) => [result.status, result.error?.code])).toEqual([
      ['rejected', 'unsupported_version'], ['rejected', 'invalid_payload'], ['rejected', 'invalid_payload'],
    ]);
    expect(await counts()).toEqual(before);
  });

  it('happy path: Mug x1 + Beans(500) x2 is Delivered, priced, backdated and records SALE movements', async () => {
    const before = [await stock(variantIds.mug[0]), await stock(variantIds.beans[0])];
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
    expect(order.customer.emailAddress).toBe('walk-in@vendurepos.invalid');
    expect(order.lines).toHaveLength(2);
    const movements = [];
    for (const posLine of command.payload.lines) {
      const line = order.lines.find(line => line.customFields.tallyClientLineId === posLine.clientLineId)!;
      expect(line.customFields).toMatchObject({
        tallyClientLineId: posLine.clientLineId, tallyUnitPrice: posLine.unitPriceMinor, tallyPriceIncludesTax: false,
      });
      expect(line.quantity).toBe(posLine.quantity);
      const sales = await connection.rawConnection.getRepository(Sale).find({ where: { orderLine: { id: line.id } } });
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ type: 'SALE', quantity: -posLine.quantity });
      movements.push(sales[0].quantity);
    }
    expect(order.shippingLines).toHaveLength(1);
    expect(order.shippingLines[0].shippingMethod.code).toBe('tally-in-store');
    expect(order.shippingWithTax).toBe(0);
    expect(order.fulfillments.map(item => item.state)).toEqual(['Delivered']);
    expect(order.payments.map(payment => [payment.state, payment.amount])).toEqual([['Settled', 2250]]);
    const ledger = await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: command.id });
    expect(ledger).toMatchObject({ status: 'applied', result, fingerprint: commandFingerprint(command) });
    const after = [await stock(variantIds.mug[0]), await stock(variantIds.beans[0])];
    expect(after).toEqual([before[0] - 1, before[1] - 2]);
    console.log('S1-NUM', JSON.stringify({ proof: 'happy', totalMinor: order.totalWithTax, state: order.state, before, after, sales: movements }));
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
    console.log('S1-NUM', JSON.stringify({ proof: 'per-line-tax-mode', prices, totalMinor: order.totalWithTax }));
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
    const ids = order.lines.map(line => line.customFields.tallyClientLineId).sort();
    expect(order.lines).toHaveLength(2);
    expect(ids).toEqual(command.payload.lines.map(line => line.clientLineId).sort());
    expect(order.lines.map(line => line.quantity)).toEqual([1, 1]);
    console.log('S1-NUM', JSON.stringify({ proof: 8, posLines: 2, orderLines: order.lines.length, totalMinor: order.totalWithTax }));
  });

  it('proof 9: split cash 500 and external remainder settle exactly', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 500 }, { method: 'external', amountMinor: 500 }]);
    const { order } = await applied(command);
    const payments = [...order.payments].sort((a, b) => Number(a.id) - Number(b.id));
    expect(payments.map(payment => payment.amount)).toEqual([500, 500]);
    expect(payments.map(payment => payment.state)).toEqual(['Settled', 'Settled']);
    expect(payments.map(payment => payment.metadata.tender)).toEqual(command.payload.payments);
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
    console.log('S1-NUM', JSON.stringify({ proof: '9-split', payments: payments.map(payment => payment.amount), totalMinor: order.totalWithTax }));
  });

  it('proof 9: overpayment caps the covering payment at 1000 and preserves tendered 2000/change 1000', async () => {
    const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 2000, tenderedMinor: 2000, changeMinor: 1000 }]);
    const { order } = await applied(command);
    expect(order.payments.map(payment => payment.amount)).toEqual([1000]);
    const tenders = JSON.parse(order.customFields.tallyPayments!);
    expect(tenders).toEqual(command.payload.payments);
    console.log('S1-NUM', JSON.stringify({ proof: '9-overpayment', payment: order.payments[0].amount, tendered: tenders[0].tenderedMinor, change: tenders[0].changeMinor }));
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
    console.log('S1-NUM', JSON.stringify({ proof: '9-zero', totalMinor: order.totalWithTax, payments: order.payments.length, transitions }));
  });

  it('proof 5: returned OrderStateTransitionError for underpayment rolls back order, lines, payments and stock movements; rejection is stored', async () => {
    const before = await counts();
    const stockBefore = await stock(variantIds.mug[0]);
    // These spies call Vendure unchanged: no mock implementation or synthetic ErrorResult.
    const transition = vi.spyOn(server.app.get(OrderService), 'transitionToState');
    const payment = vi.spyOn(server.app.get(PaymentService), 'createPayment');
    try {
      const command = orderCommand([mug()], [{ method: 'cash', amountMinor: 500 }]);
      const result = await submit(command);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'ORDER_STATE_TRANSITION_ERROR' } });
      expect(transition.mock.calls.at(-1)?.[2]).toBe('PaymentSettled');
      const returned = await transition.mock.results.at(-1)!.value;
      expect(Boolean(isGraphQlErrorResult(returned))).toBe(true);
      expect(returned.__typename).toBe('OrderStateTransitionError');
      expect(payment).toHaveBeenCalledTimes(1);
      expect(await payment.mock.results[0].value).toMatchObject({ amount: 500, state: 'Settled' });
      const after = await counts();
      expect(after).toEqual({ ...before, commands: before.commands + 1 });
      const ledger = await connection.rawConnection.getRepository(TallyCommand).find({ where: { id: command.id } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ status: 'rejected', result });
      expect(await stock(variantIds.mug[0])).toBe(stockBefore);
      console.log('S1-NUM', JSON.stringify({ proof: 5, error: returned.__typename, before, after }));
    } finally {
      transition.mockRestore();
      payment.mockRestore();
    }
  });

  it('reuses the walk-in customer and resolves a customer id before email, with unknown-id email fallback', async () => {
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: 'walk-in@vendurepos.invalid' } })).toBe(1);
    const line = { variantId: variantIds.beans[1], quantity: 1, unitPriceMinor: 900 };
    const first = await applied(orderCommand([line], undefined, { customerId: '999999', email: 's1-buyer@example.com' }));
    const second = await applied(orderCommand([line], undefined, { customerId: String(first.order.customer.id), email: 'unused@example.com' }));
    const third = await applied(orderCommand([line], undefined, { email: 's1-buyer@example.com' }));
    expect(first.order.customer.emailAddress).toBe('s1-buyer@example.com');
    expect(second.order.customer.id).toBe(first.order.customer.id);
    expect(third.order.customer.id).toBe(first.order.customer.id);
    expect(await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: 'unused@example.com' } })).toBe(0);
  });
});
