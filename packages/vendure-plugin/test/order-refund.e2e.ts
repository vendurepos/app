import { randomUUID } from 'node:crypto';
import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload } from '../src/vendored/core-commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type ReadOrder = {
  id: string; shippingWithTax: number;
  lines: Array<{ id: string; quantity: number; proratedUnitPriceWithTax: number; productVariant: { id: string; stockOnHand: number } }>;
  payments: Array<{ id: string; method: string; amount: number; refunds: Array<{
    id: string; total: number; state: string; shipping: number; metadata: Record<string, unknown>;
    lines: Array<{ orderLineId: string; quantity: number }>;
  }> }>;
};
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };

describe('order.refund v1', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let base: string;
  let refunder: Record<string, string>;
  let seller: Record<string, string>;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
    refunder = await tokenWith(['TallyPosSell', 'TallyPosRefund']);
    seller = await tokenWith(['TallyPosSell']);
  });
  afterAll(() => server.destroy());

  const headers = (token: Record<string, string>) => ({ 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...token });
  async function post(command: unknown, token = refunder): Promise<CommandResult> {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ commands: [command] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).results[0];
  }
  async function tokenWith(permissions: Array<'TallyPosSell' | 'TallyPosRefund'>) {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `refund-${randomUUID()}`, description: 'Till refund test', permissions, channelIds: [activeChannel.id] } });
    const emailAddress = `${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: 'Refund', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const response = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") {
        ... on CurrentUser { id } ... on ErrorResult { errorCode } } }` }),
    });
    expect((await response.json()).data.login).toMatchObject({ id: expect.any(String) });
    const token = response.headers.get('vendure-auth-token');
    expect(token).toBeTruthy();
    return { Authorization: `Bearer ${token}` };
  }
  const envelope = (type: string, payload: Record<string, unknown>) => ({
    id: randomUUID(), type, version: 1, createdAt: new Date().toISOString(), deviceId: 'refund-till', attempt: 1, payload,
  });
  async function openSession() {
    const session = { registerId: randomUUID(), sessionId: randomUUID() };
    expect(await post(envelope('register.session.open', {
      ...session, openedAt: new Date().toISOString(), countedFloatMinor: 0,
    }))).toMatchObject({ status: 'applied' });
    return session;
  }
  async function readOrder(id: string): Promise<ReadOrder> {
    const { order } = await adminClient.query<{ order: ReadOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      id shippingWithTax lines { id quantity proratedUnitPriceWithTax productVariant { id stockOnHand } }
      payments { id method amount refunds { id total state shipping metadata lines { orderLineId quantity } } }
    } }`), { id });
    return order;
  }
  async function sell(quantity: number, method: 'cash' | 'external' | 'split' = 'cash') {
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800 }]);
    command.payload.payments = method === 'split'
      ? [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 500 },
        { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', amountMinor: command.payload.totalMinor - 500 }]
      : [{ clientPaymentId: randomUUID(), method, amountMinor: command.payload.totalMinor,
        ...(method === 'external' ? { reference: 'card-1' } : {}) }];
    const result = await post(command);
    expect(result).toMatchObject({ status: 'applied' });
    return { order: await readOrder(result.serverRefs!.orderId), clientOrderId: command.payload.clientOrderId };
  }
  function refundFor(order: ReadOrder, session: { registerId: string; sessionId: string }, overrides: Partial<OrderRefundPayload> = {}): RefundCommand {
    const createdAt = new Date().toISOString();
    const payload = {
      clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt,
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity, restock: true })),
      shippingMinor: order.shippingWithTax, adjustmentMinor: 0, destination: 'original_method' as const, reason: 'Returned at till',
      ...overrides,
    };
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'refund-till', attempt: 1,
      payload: { ...payload, totalMinor: overrides.totalMinor ?? payload.lines.reduce((sum, line) => sum
        + line.quantity * order.lines.find(item => item.id === line.orderLineId)!.proratedUnitPriceWithTax, 0)
        + payload.shippingMinor + payload.adjustmentMinor } };
  }
  async function refused(command: RefundCommand, orderId: string, code: string, message: string, data?: Record<string, unknown>, token = refunder) {
    const before = (await readOrder(orderId)).payments.flatMap(payment => payment.refunds);
    expect(await post(command, token)).toEqual({ id: command.id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id })).toBeNull();
    expect((await readOrder(orderId)).payments.flatMap(payment => payment.refunds)).toEqual(before);
  }

  it('a till refund applies, settles with the till metadata, restocks and replays as duplicate', async () => {
    const session = await openSession();
    const { order } = await sell(2);
    const line = order.lines[0];
    const command = refundFor(order, session, { lines: [{ orderLineId: line.id, quantity: 1, restock: true }] });
    const result = await post(command);
    expect(result).toEqual({ id: command.id, status: 'applied', refund: {
      totalMinor: line.proratedUnitPriceWithTax, byMethod: { cash: line.proratedUnitPriceWithTax },
      refunds: [{ id: expect.any(String), paymentId: order.payments[0].id, totalMinor: line.proratedUnitPriceWithTax, state: 'Settled' }],
    } });
    const after = await readOrder(order.id);
    expect(after.payments[0].refunds[0].metadata).toEqual({
      tallyClientRefundId: command.payload.clientRefundId, tallyRegisterId: session.registerId, tallySessionId: session.sessionId,
      tallyCashierRef: command.payload.cashierRef, tallyDestination: 'original_method', tallyMethod: 'cash',
    });
    expect(after.lines[0].productVariant.stockOnHand).toBe(line.productVariant.stockOnHand + 1);
    expect(await post(command)).toEqual({ ...result, status: 'duplicate' });
    expect(await readOrder(order.id)).toEqual(after);
  });

  it('restock false leaves stock alone, and an external refund to cash leaves as cash', async () => {
    const session = await openSession();
    const { order } = await sell(1, 'external');
    const line = order.lines[0];
    const command = refundFor(order, session, { destination: 'cash', lines: [{ orderLineId: line.id, quantity: 1, restock: false }] });
    expect(await post(command)).toMatchObject({ status: 'applied', refund: { byMethod: { cash: line.proratedUnitPriceWithTax } } });
    const after = await readOrder(order.id);
    expect(after.payments[0].refunds[0].metadata.tallyMethod).toBe('cash');
    expect(after.lines[0].productVariant.stockOnHand).toBe(line.productVariant.stockOnHand);
  });

  it('a refund over two tenders splits by payment id and records the lines once', async () => {
    const session = await openSession();
    const { order } = await sell(2, 'split');
    const command = refundFor(order, session);
    const result = await post(command);
    const payments = [...order.payments].sort((a, b) => Number(environment.decode(a.id)) - Number(environment.decode(b.id)));
    expect(result).toEqual({ id: command.id, status: 'applied', refund: {
      totalMinor: command.payload.totalMinor, byMethod: { cash: 500, external: command.payload.totalMinor - 500 },
      refunds: [
        { id: expect.any(String), paymentId: payments[0].id, totalMinor: 500, state: 'Settled' },
        { id: expect.any(String), paymentId: payments[1].id, totalMinor: command.payload.totalMinor - 500, state: 'Settled' },
      ],
    } });
    expect(Object.values(result.refund!.byMethod).reduce((sum, amount) => sum + amount, 0)).toBe(result.refund!.totalMinor);
    const after = await readOrder(order.id);
    expect(after.payments.find(payment => payment.id === payments[0].id)!.refunds).toEqual([expect.objectContaining({
      total: 500, shipping: order.shippingWithTax, lines: [{ orderLineId: order.lines[0].id, quantity: 2 }],
    })]);
    expect(after.payments.find(payment => payment.id === payments[1].id)!.refunds).toEqual([expect.objectContaining({
      total: command.payload.totalMinor - 500, shipping: 0, lines: [],
      metadata: expect.objectContaining({ tallyMethod: 'external' }),
    })]);
  });

  it('the remainder can be refunded later, and no more', async () => {
    const session = await openSession();
    const { order } = await sell(2);
    const lines = [{ orderLineId: order.lines[0].id, quantity: 1, restock: true }];
    expect(await post(refundFor(order, session, { lines }))).toMatchObject({ status: 'applied' });
    expect(await post(refundFor(order, session, { lines }))).toMatchObject({ status: 'applied' });
    await refused(refundFor(order, session, { lines }), order.id, 'quantity_exceeds',
      'A refunded quantity is more than the line has left to refund', { lines: [{ orderLineId: lines[0].orderLineId, quantity: 1, refundableQuantity: 0 }] });
  });

  it('refusals are unstored and name the contract code', async () => {
    const session = await openSession();
    const { order, clientOrderId } = await sell(2);
    const lines = [{ orderLineId: order.lines[0].id, quantity: 1, restock: true }];
    const command = refundFor(order, session, { lines });
    await refused(command, order.id, 'forbidden', 'TallyPosRefund is required to refund', undefined, seller);
    expect(await post(command)).toMatchObject({ status: 'applied' });
    const unknown = randomUUID();
    await refused(refundFor(order, session, { lines, sessionId: unknown }), order.id, 'no_open_session',
      `Session ${unknown} is not open on register ${session.registerId}`, { sessionId: unknown });
    const closed = await openSession();
    expect(await post(envelope('register.session.transition', {
      sessionId: closed.sessionId, status: 'closed', at: new Date().toISOString(),
    }))).toMatchObject({ status: 'applied' });
    await refused(refundFor(order, closed, { lines }), order.id, 'no_open_session',
      `Session ${closed.sessionId} is not open on register ${closed.registerId}`, { sessionId: closed.sessionId });
    const unknownOrder = environment.encode(2147483647);
    await refused(refundFor(order, session, { lines, orderId: unknownOrder }), order.id, 'invalid_payload',
      `orderId: no order ${unknownOrder} in this channel`);
    await refused(refundFor(order, session, { lines, clientOrderId: randomUUID() }), order.id, 'invalid_payload',
      `clientOrderId: order ${order.id} is ${clientOrderId}`);
    const { order: nonTill } = await sell(1);
    await connection.rawConnection.getRepository(Order).update(environment.decode(nonTill.id), { customFields: { tallyClientOrderId: null } });
    await refused(refundFor(nonTill, session), nonTill.id, 'not_till_order', `Order ${nonTill.id} was not taken at a till`);
    await refused(refundFor(order, session, { lines: [{ ...lines[0], quantity: 3 }] }), order.id, 'quantity_exceeds',
      'A refunded quantity is more than the line has left to refund', { lines: [{ orderLineId: lines[0].orderLineId, quantity: 3, refundableQuantity: 1 }] });
    const server = order.lines[0].proratedUnitPriceWithTax;
    await refused(refundFor(order, session, { lines, totalMinor: server + 1 }), order.id, 'amount_mismatch',
      `Refund total ${server + 1} does not match the server's ${server}`, { expectedMinor: server + 1, serverMinor: server });
    await refused(refundFor(order, session, { lines: [], shippingMinor: 0, adjustmentMinor: 0 }), order.id, 'nothing_to_refund', 'Nothing to refund');
    await refused({ ...refundFor(order, session, { lines }), version: 2 }, order.id, 'unsupported_version',
      'order.refund version 2 is not supported; this server supports 1', { orderRefund: 1 });
  });

  it('a till refund cannot take money already refunded outside the till', async () => {
    const session = await openSession();
    const { order } = await sell(2);
    const { refundOrder } = await adminClient.query<{ refundOrder: { total: number; state: string } }>(parse(`mutation Refund($input: RefundOrderInput!) {
      refundOrder(input: $input) { ... on Refund { id total state } ... on ErrorResult { errorCode message } }
    }`), { input: { paymentId: order.payments[0].id, amount: 1000, shipping: 0, adjustment: 0, reason: 'Back office' } });
    expect(refundOrder).toMatchObject({ total: 1000, state: 'Settled' });
    const full = order.lines[0].quantity * order.lines[0].proratedUnitPriceWithTax + order.shippingWithTax;
    expect(full).toBeGreaterThan(order.payments[0].amount - 1000);
    await refused(refundFor(order, session), order.id, 'amount_mismatch',
      `Refund total ${full} does not match the server's ${order.payments[0].amount - 1000}`,
      { expectedMinor: full, serverMinor: order.payments[0].amount - 1000 });
  });

  it('/info advertises order.refund 1', async () => {
    const response = await fetch(`${base}/tally/v1/info`, { headers: headers(refunder) });
    expect(response.status).toBe(200);
    expect((await response.json()).contracts['order.refund']).toEqual([1]);
  });

  describe('refunds in register figures', () => {
    it('a cash refund lowers the live expected cash of the session that made it', async () => {
      const session = { registerId: randomUUID(), sessionId: randomUUID() };
      const countedFloatMinor = 10000;
      expect(await post(envelope('register.session.open', {
        ...session, openedAt: new Date().toISOString(), countedFloatMinor,
      }))).toMatchObject({ status: 'applied' });
      const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
        undefined, undefined, { sessionId: session.sessionId });
      const sold = await post(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      const refund = refundFor(order, session, { destination: 'cash' });
      expect(await post(refund)).toMatchObject({ status: 'applied' });
      const result = await post(envelope('register.session.transition', {
        sessionId: session.sessionId, status: 'open', at: new Date().toISOString(),
      }));
      expect(result).toMatchObject({ status: 'applied' });
      expect(result.register!.session!.expected).toEqual({ cash: countedFloatMinor + sale.payload.totalMinor - refund.payload.totalMinor });
      expect(result.register!.session).not.toHaveProperty('refundsTotalMinor');
    });

    it('an original-method external refund lowers external, not cash, and a refund counts in the refunding session only', async () => {
      const sessionA = await openSession();
      const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
        undefined, undefined, { sessionId: sessionA.sessionId });
      sale.payload.payments = [{ clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', amountMinor: sale.payload.totalMinor }];
      const sold = await post(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      expect(await post(envelope('register.session.transition', {
        sessionId: sessionA.sessionId, status: 'closed', at: new Date().toISOString(),
      }))).toMatchObject({ status: 'applied' });
      const sessionB = await openSession();
      const refund = refundFor(order, sessionB, { destination: 'original_method' });
      expect(await post(refund)).toMatchObject({ status: 'applied' });
      const result = await post(envelope('register.session.transition', {
        sessionId: sessionB.sessionId, status: 'open', at: new Date().toISOString(),
      }));
      expect(result).toMatchObject({ status: 'applied' });
      expect(result.register!.session!.expected).toEqual({ cash: 0, external: -refund.payload.totalMinor });
    });

    it('the closure expected counts the session refunds, and the counters carry perpetualRefundsTotalMinor', async () => {
      const session = { registerId: randomUUID(), sessionId: randomUUID() };
      const countedFloatMinor = 10000;
      const openedAt = new Date().toISOString();
      expect(await post(envelope('register.session.open', { ...session, openedAt, countedFloatMinor })))
        .toMatchObject({ status: 'applied' });
      const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
        undefined, undefined, { sessionId: session.sessionId });
      const sold = await post(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      const refund = refundFor(order, session, { destination: 'cash' });
      expect(await post(refund)).toMatchObject({ status: 'applied' });
      const expectedCash = countedFloatMinor + sale.payload.totalMinor - refund.payload.totalMinor;
      const result = await post(envelope('register.closure.submit', {
        ...session, closureId: randomUUID(), number: 1, openedAt, closedAt: new Date().toISOString(),
        tillExpected: { cash: expectedCash }, counted: { cash: expectedCash },
        periodSalesTotalMinor: sale.payload.totalMinor, periodRefundsTotalMinor: refund.payload.totalMinor,
        perpetualSalesTotalMinor: sale.payload.totalMinor, perpetualRefundsTotalMinor: 123,
        unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '3.9.1',
        orderIds: [sale.payload.clientOrderId], movementIds: [],
      }));
      expect(result).toMatchObject({ status: 'applied' });
      expect(result.register!.closure!.expected!.cash).toBe(expectedCash);
      expect(result.register!.counters!.perpetualRefundsTotalMinor).toBe(123);
    });
  });
});
