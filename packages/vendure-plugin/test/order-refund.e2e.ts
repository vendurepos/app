import { randomUUID } from 'node:crypto';
import { Order, Payment, PaymentService, Refund, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { parse } from 'graphql';
import { In } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyCommand } from '../src';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type ReadOrder = {
  id: string; shippingWithTax: number;
  lines: Array<{ id: string; quantity: number; proratedUnitPriceWithTax: number; proratedLinePriceWithTax: number; productVariant: { id: string; stockOnHand: number } }>;
  payments: Array<{ id: string; method: string; amount: number; refunds: Array<{
    id: string; total: number; state: string; shipping: number; metadata: Record<string, unknown>;
    lines: Array<{ orderLineId: string; quantity: number }>;
  }> }>;
};
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };

describe('order.refund v1', () => {
  // A non-Tally handler beside the plugin's, for (w)'s method that shares a Tally method's code.
  const environment = createPluginTestEnvironment({ paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] } });
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let base: string;
  let refunder: Record<string, string>;
  let auditor: Record<string, string>;
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
    auditor = await tokenWith(['TallyPosSell', 'TallyPosRefund', 'ApproveTallyPosVariance']);
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
  async function tokenWith(permissions: Array<'TallyPosSell' | 'TallyPosRefund' | 'ApproveTallyPosVariance'>) {
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
      id shippingWithTax lines { id quantity proratedUnitPriceWithTax proratedLinePriceWithTax productVariant { id stockOnHand } }
      payments { id method amount refunds { id total state shipping metadata lines { orderLineId quantity } } }
    } }`), { id });
    return order;
  }
  async function sell(quantity: number, method: 'cash' | 'external' | 'split' = 'cash', unitPriceMinor = 800) {
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity, unitPriceMinor }]);
    command.payload.payments = method === 'split'
      ? [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 500 },
        { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', amountMinor: command.payload.totalMinor - 500 }]
      : [{ clientPaymentId: randomUUID(), method, amountMinor: command.payload.totalMinor,
        ...(method === 'external' ? { reference: 'card-1' } : {}) }];
    const result = await post(command);
    expect(result).toMatchObject({ status: 'applied' });
    return { order: await readOrder(result.serverRefs!.orderId), clientOrderId: command.payload.clientOrderId };
  }
  function refundFor(order: ReadOrder, session: { registerId: string; sessionId: string }, overrides: Partial<OrderRefundPayload> = {}, refunded: Record<string, number> = {}): RefundCommand {
    const createdAt = new Date().toISOString();
    const payload = {
      clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt,
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity, restock: true })),
      shippingMinor: order.shippingWithTax, adjustmentMinor: 0, destination: 'original_method' as const, reason: 'Returned at till',
      ...overrides,
    };
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'refund-till', attempt: 1,
      payload: { ...payload, totalMinor: overrides.totalMinor ?? payload.lines.reduce((sum, line) => {
        const item = order.lines.find(item => item.id === line.orderLineId)!;
        if (item.quantity === 0) return sum;
        const before = refunded[line.orderLineId] ?? 0;
        return sum + Math.round((before + line.quantity) * item.proratedLinePriceWithTax / item.quantity)
          - Math.round(before * item.proratedLinePriceWithTax / item.quantity);
      }, 0)
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
    // The Admin API encodes orderLineId inside metadata; the stored value is the raw id (checked below).
    expect(after.payments[0].refunds[0].metadata).toEqual({
      tallyClientRefundId: command.payload.clientRefundId, tallyRegisterId: session.registerId, tallySessionId: session.sessionId,
      tallyCashierRef: command.payload.cashierRef, tallyDestination: 'original_method', tallyMethod: 'cash',
      tallyLines: [{ orderLineId: line.id, quantity: 1 }],
    });
    const stored = await connection.rawConnection.getRepository(Refund).findOneByOrFail({ id: environment.decode(after.payments[0].refunds[0].id) });
    expect(stored.metadata.tallyLines).toEqual([{ orderLineId: String(environment.decode(line.id)), quantity: 1 }]);
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
      metadata: expect.objectContaining({ tallyLines: [{ orderLineId: order.lines[0].id, quantity: 2 }] }),
    })]);
    expect(after.payments.find(payment => payment.id === payments[1].id)!.refunds).toEqual([expect.objectContaining({
      total: command.payload.totalMinor - 500, shipping: 0, lines: [],
      metadata: expect.objectContaining({ tallyMethod: 'external', tallyLines: [] }),
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

  it('a whole line refunds its line total exactly, and partial refunds add up to it', async () => {
    const session = await openSession();
    const whole = (await sell(3, 'cash', 333)).order;
    const parts = (await sell(3, 'cash', 333)).order;
    expect(whole.lines[0].proratedLinePriceWithTax).not.toBe(3 * whole.lines[0].proratedUnitPriceWithTax);
    const T = whole.lines[0].proratedLinePriceWithTax;
    const old = 3 * whole.lines[0].proratedUnitPriceWithTax + whole.shippingWithTax;
    const server = T + whole.shippingWithTax;
    await refused(refundFor(whole, session, { totalMinor: old }), whole.id, 'amount_mismatch',
      `Refund total ${old} does not match the server's ${server}`, { expectedMinor: old, serverMinor: server });
    expect(await post(refundFor(whole, session))).toMatchObject({ status: 'applied', refund: { totalMinor: T + whole.shippingWithTax } });
    const P = parts.lines[0].proratedLinePriceWithTax;
    const lineId = parts.lines[0].id;
    const third = (refunded: number) => refundFor(parts, session, {
      lines: [{ orderLineId: lineId, quantity: 1, restock: true }], shippingMinor: 0,
    }, { [lineId]: refunded });
    expect(await post(third(0))).toMatchObject({ status: 'applied', refund: { totalMinor: Math.round(P / 3) } });
    expect(await post(third(1))).toMatchObject({ status: 'applied', refund: { totalMinor: Math.round(2 * P / 3) - Math.round(P / 3) } });
    expect(await post(third(2))).toMatchObject({ status: 'applied', refund: { totalMinor: P - Math.round(2 * P / 3) } });
    expect(Math.round(2 * P / 3) - Math.round(P / 3)).not.toBe(Math.round(P / 3));
    const after = await readOrder(parts.id);
    expect(after.payments.flatMap(payment => payment.refunds).reduce((sum, refund) => sum + refund.total, 0)).toBe(P);
  });

  // Money P1 (Fable money-path review, finding 1): a till line discount is stored as a negative Surcharge, not on the line.
  async function sellDiscounted(lines: Array<{ variantId: string; unitPriceMinor: number; discountMinor?: number }>) {
    const command = { ...orderCommand(lines.map(line => ({ ...line, quantity: 1 }))), version: 10 };
    const result = await post(command);
    expect(result).toMatchObject({ status: 'applied' });
    const order = await readOrder(result.serverRefs!.orderId);
    const paid = order.payments.reduce((sum, payment) => sum + payment.amount, 0);
    expect(paid).toBe(command.payload.totalMinor);
    return { order, paid };
  }
  const wholeLine = (order: ReadOrder, line: ReadOrder['lines'][number], session: { registerId: string; sessionId: string }, totalMinor: number) =>
    refundFor(order, session, { lines: [{ orderLineId: line.id, quantity: line.quantity, restock: true }], shippingMinor: 0, totalMinor });

  it('refunds a discounted line for what the customer paid, and the rest of the order stays refundable', async () => {
    const session = await openSession();
    const { order, paid } = await sellDiscounted([
      { variantId: variantIds.mug[0], unitPriceMinor: 1000, discountMinor: 200 },
      { variantId: variantIds.beans[0], unitPriceMinor: 500 },
    ]);
    const a = order.lines.find(line => line.productVariant.id === variantIds.mug[0])!;
    const b = order.lines.find(line => line.productVariant.id === variantIds.beans[0])!;
    const paidForA = paid - b.proratedLinePriceWithTax;
    expect(await post(wholeLine(order, a, session, paidForA))).toMatchObject({ status: 'applied', refund: { totalMinor: paidForA } });
    expect(await post(wholeLine(order, b, session, b.proratedLinePriceWithTax)))
      .toMatchObject({ status: 'applied', refund: { totalMinor: b.proratedLinePriceWithTax } });
    const refunds = (await readOrder(order.id)).payments.flatMap(payment => payment.refunds).filter(refund => refund.state !== 'Failed');
    expect(refunds.reduce((sum, refund) => sum + refund.total, 0)).toBe(paid);
  });

  it('a single discounted line refunds in full for the amount paid', async () => {
    const session = await openSession();
    const { order, paid } = await sellDiscounted([{ variantId: variantIds.mug[0], unitPriceMinor: 1000, discountMinor: 200 }]);
    expect(await post(wholeLine(order, order.lines[0], session, paid))).toMatchObject({ status: 'applied', refund: { totalMinor: paid } });
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

  it('a till sale an administrator cancelled is refused order_state, and a replay is refused the same', async () => {
    const session = await openSession();
    const { order, clientOrderId } = await sell(1);
    const { cancelOrder } = await adminClient.query<{ cancelOrder: { id: string; state: string } }>(parse(`mutation Cancel($input: CancelOrderInput!) {
      cancelOrder(input: $input) { ... on Order { id state } ... on ErrorResult { errorCode message } }
    }`), { input: { orderId: order.id, lines: [{ orderLineId: order.lines[0].id, quantity: 1 }], reason: 'Back office' } });
    expect(cancelOrder).toEqual({ id: order.id, state: 'Cancelled' });
    const stored = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: environment.decode(order.id) });
    expect([stored.state, stored.customFields.tallyClientOrderId]).toEqual(['Cancelled', clientOrderId]);
    const stock = (await readOrder(order.id)).lines[0].productVariant.stockOnHand;
    const command = refundFor(order, session);
    for (let attempt = 0; attempt < 2; attempt++) {
      await refused(command, order.id, 'order_state', `Order ${order.id} is Cancelled and cannot be refunded`, { state: 'Cancelled' });
    }
    expect((await readOrder(order.id)).lines[0].productVariant.stockOnHand).toBe(stock);
  });

  it('a line from another order is refused invalid_payload', async () => {
    const session = await openSession();
    const { order } = await sell(1);
    const { order: other } = await sell(1);
    const foreign = other.lines[0].id;
    await refused(refundFor(order, session, { lines: [{ orderLineId: foreign, quantity: 1, restock: true }], totalMinor: order.lines[0].proratedUnitPriceWithTax }),
      order.id, 'invalid_payload', `lines[0].orderLineId: no line ${foreign} on order ${order.id}`);
  });

  it('shipping beyond what is refundable is refused amount_mismatch', async () => {
    const session = await openSession();
    const { order } = await sell(2);
    expect(order.shippingWithTax).toBe(0);
    const command = refundFor(order, session, { lines: [{ orderLineId: order.lines[0].id, quantity: 1, restock: true }], shippingMinor: 100 });
    const t = Math.round(order.lines[0].proratedLinePriceWithTax / 2) + 100;
    expect(command.payload.totalMinor).toBe(t);
    expect(t).toBeLessThan(order.payments.reduce((sum, payment) => sum + payment.amount, 0));
    await refused(command, order.id, 'amount_mismatch', `Refund total ${t} does not match the server's ${t}`, { expectedMinor: t, serverMinor: t });
  });

  it('a refund above the paid remainder is refused amount_mismatch at the remainder', async () => {
    const session = await openSession();
    const { order } = await sell(1);
    const paid = order.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const command = refundFor(order, session, { adjustmentMinor: 1 });
    expect(command.payload.totalMinor).toBe(paid + 1);
    await refused(command, order.id, 'amount_mismatch', `Refund total ${paid + 1} does not match the server's ${paid}`,
      { expectedMinor: paid + 1, serverMinor: paid });
  });

  it('a refund whose lines net to zero is refused nothing_to_refund', async () => {
    const session = await openSession();
    const { order } = await sell(1);
    const line = order.lines[0];
    await refused(refundFor(order, session, { shippingMinor: 0, adjustmentMinor: -line.proratedLinePriceWithTax, totalMinor: 0 }),
      order.id, 'nothing_to_refund', 'Nothing to refund');
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

  it('a second command with an applied clientRefundId is refused, and a Failed refund frees it', async () => {
    const session = await openSession();
    const { order } = await sell(2);
    const lines = [{ orderLineId: order.lines[0].id, quantity: 1, restock: false }];
    const first = refundFor(order, session, { lines });
    const result = await post(first);
    expect(result).toMatchObject({ status: 'applied' });
    const refundId = result.refund!.refunds[0].id;
    const again = refundFor(order, session, { clientRefundId: first.payload.clientRefundId, lines }, { [order.lines[0].id]: 1 });
    await refused(again, order.id, 'invalid_payload', `clientRefundId: ${first.payload.clientRefundId} is already refund ${refundId}`);
    await connection.rawConnection.getRepository(Refund).update(environment.decode(refundId), { state: 'Failed' });
    const retry = refundFor(order, session, { clientRefundId: first.payload.clientRefundId, lines }, {});
    expect(await post(retry)).toMatchObject({ status: 'applied' });
  });

  it('a restock returns only units not already returned, whoever cancelled them', async () => {
    const session = await openSession();
    {
      const { order } = await sell(3);
      const stock = order.lines[0].productVariant.stockOnHand;
      const result = await post(refundFor(order, session, {
        lines: [{ orderLineId: order.lines[0].id, quantity: 1, restock: true }], shippingMinor: 0,
      }));
      expect(result).toMatchObject({ status: 'applied' });
      const after = await readOrder(order.id);
      expect(after.lines[0].productVariant.stockOnHand).toBe(stock + 1);
      const refundId = result.refund!.refunds[0].id;
      await connection.rawConnection.getRepository(Refund).update(environment.decode(refundId), { state: 'Failed' });
      expect(await post(refundFor(after, session))).toMatchObject({ status: 'applied' });
      expect((await readOrder(order.id)).lines[0].productVariant.stockOnHand).toBe(stock + 3);
    }
    {
      const { order } = await sell(3);
      const stock = order.lines[0].productVariant.stockOnHand;
      const { cancelOrder } = await adminClient.query<{ cancelOrder: { id: string } }>(parse(`mutation Cancel($input: CancelOrderInput!) {
        cancelOrder(input: $input) { ... on Order { id } ... on ErrorResult { errorCode message } }
      }`), { input: { orderId: order.id, lines: [{ orderLineId: order.lines[0].id, quantity: 1 }], reason: 'Back office' } });
      expect(cancelOrder).toMatchObject({ id: order.id });
      const after = await readOrder(order.id);
      expect(after.lines[0].productVariant.stockOnHand).toBe(stock + 1);
      expect(await post(refundFor(after, session))).toMatchObject({ status: 'applied' });
      expect((await readOrder(order.id)).lines[0].productVariant.stockOnHand).toBe(stock + 3);
    }
  });

  // Three tills, because one till's refunds are already serialised by the register's advisory lock; only separate registers reach the order-row lock.
  it('three whole-order refunds sent at once from three tills: one applies, the rest are refused, and no more than was paid leaves', async () => {
    const sessions = [await openSession(), await openSession(), await openSession()];
    const { order } = await sell(2);
    const paid = order.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const results = await Promise.all(sessions.map(session => post(refundFor(order, session)))) as Array<{ status: string; error?: { code: string } }>;
    expect(results.filter(result => result.status === 'applied')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => result.error?.code)).toEqual(['quantity_exceeds', 'quantity_exceeds']);
    const refunded = (await readOrder(order.id)).payments.flatMap(payment => payment.refunds)
      .filter(refund => refund.state !== 'Failed').reduce((sum, refund) => sum + refund.total, 0);
    expect(refunded).toBe(paid);
  });

  it('/info advertises order.refund 1', async () => {
    const response = await fetch(`${base}/tally/v1/info`, { headers: headers(refunder) });
    expect(response.status).toBe(200);
    expect((await response.json()).contracts['order.refund']).toEqual([1]);
  });

  describe('refunds in register figures', () => {
    // 4.3c: a reply carries expected cash only for a holder of ApproveTallyPosVariance, so these tests post as one.
    const seen = (command: unknown) => post(command, auditor);
    it('a cash refund lowers the live expected cash of the session that made it', async () => {
      const session = { registerId: randomUUID(), sessionId: randomUUID() };
      const countedFloatMinor = 10000;
      expect(await seen(envelope('register.session.open', {
        ...session, openedAt: new Date().toISOString(), countedFloatMinor,
      }))).toMatchObject({ status: 'applied' });
      const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
        undefined, undefined, { sessionId: session.sessionId });
      const sold = await seen(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      const refund = refundFor(order, session, { destination: 'cash' });
      expect(await seen(refund)).toMatchObject({ status: 'applied' });
      const result = await seen(envelope('register.session.transition', {
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
      const sold = await seen(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      expect(await seen(envelope('register.session.transition', {
        sessionId: sessionA.sessionId, status: 'closed', at: new Date().toISOString(),
      }))).toMatchObject({ status: 'applied' });
      const sessionB = await openSession();
      const refund = refundFor(order, sessionB, { destination: 'original_method' });
      expect(await seen(refund)).toMatchObject({ status: 'applied' });
      const result = await seen(envelope('register.session.transition', {
        sessionId: sessionB.sessionId, status: 'open', at: new Date().toISOString(),
      }));
      expect(result).toMatchObject({ status: 'applied' });
      expect(result.register!.session!.expected).toEqual({ cash: 0, external: -refund.payload.totalMinor });
    });

    it('the closure expected counts the session refunds, and the counters carry perpetualRefundsTotalMinor', async () => {
      const session = { registerId: randomUUID(), sessionId: randomUUID() };
      const countedFloatMinor = 10000;
      const openedAt = new Date().toISOString();
      expect(await seen(envelope('register.session.open', { ...session, openedAt, countedFloatMinor })))
        .toMatchObject({ status: 'applied' });
      const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
        undefined, undefined, { sessionId: session.sessionId });
      const sold = await seen(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      const refund = refundFor(order, session, { destination: 'cash' });
      expect(await seen(refund)).toMatchObject({ status: 'applied' });
      const expectedCash = countedFloatMinor + sale.payload.totalMinor - refund.payload.totalMinor;
      const result = await seen(envelope('register.closure.submit', {
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

    it('a Failed refund leaves the session figures', async () => {
      const session = { registerId: randomUUID(), sessionId: randomUUID() };
      const countedFloatMinor = 10000;
      expect(await seen(envelope('register.session.open', {
        ...session, openedAt: new Date().toISOString(), countedFloatMinor,
      }))).toMatchObject({ status: 'applied' });
      const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
        undefined, undefined, { sessionId: session.sessionId });
      const sold = await seen(sale);
      expect(sold).toMatchObject({ status: 'applied' });
      const order = await readOrder(sold.serverRefs!.orderId);
      const refund = await seen(refundFor(order, session, { destination: 'cash' }));
      expect(refund).toMatchObject({ status: 'applied' });
      const refundId = refund.refund!.refunds[0].id;
      await connection.rawConnection.getRepository(Refund).update(environment.decode(refundId), { state: 'Failed' });
      const result = await seen(envelope('register.session.transition', {
        sessionId: session.sessionId, status: 'open', at: new Date().toISOString(),
      }));
      expect(result).toMatchObject({ status: 'applied' });
      expect(result.register!.session!.expected).toEqual({ cash: countedFloatMinor + sale.payload.totalMinor });
    });
  });

  // 3.2a-2 (p): last in the file, since the methods it creates change where later cash sales are recorded.
  it('(p) a split sale under card-terminal and cash refunds to both, each by its tender method', async () => {
    for (const [code, name, tender] of [['card-terminal', 'Card terminal', 'card'], ['cash', 'Cash', 'cash']]) {
      await adminClient.query(parse(`mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
        code, enabled: true, handler: { code: 'tally-pos', arguments: [{ name: 'tender', value: tender }] },
        checker: { code: 'tally-pos', arguments: [] }, translations: [{ languageCode: 'en', name, description: '' }] } });
    }
    const session = await openSession();
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800 }]), version: 10 };
    // The vendored OrderCreatePayment type has no methodId yet.
    (command.payload as { payments: unknown[] }).payments = [
      { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', methodId: 'card-terminal', amountMinor: command.payload.totalMinor - 500 },
      { clientPaymentId: randomUUID(), method: 'cash', amountMinor: 500 },
    ];
    const sold = await post(command);
    expect(sold).toMatchObject({ status: 'applied' });
    const order = await readOrder(sold.serverRefs!.orderId);
    const payments = [...order.payments].sort((a, b) => Number(environment.decode(a.id)) - Number(environment.decode(b.id)));
    expect(payments.map(payment => payment.method)).toEqual(['card-terminal', 'cash']);
    const refund = refundFor(order, session);
    const result = await post(refund);
    expect(result).toEqual({ id: refund.id, status: 'applied', refund: {
      totalMinor: refund.payload.totalMinor, byMethod: { external: refund.payload.totalMinor - 500, cash: 500 },
      refunds: [
        { id: expect.any(String), paymentId: payments[0].id, totalMinor: refund.payload.totalMinor - 500, state: 'Settled' },
        { id: expect.any(String), paymentId: payments[1].id, totalMinor: 500, state: 'Settled' },
      ],
    } });
    const after = await readOrder(order.id);
    expect(payments.map(({ id }) => after.payments.find(payment => payment.id === id)!.refunds.map(item => item.metadata.tallyMethod)))
      .toEqual([['external'], ['cash']]);
  });

  // 3.2a-2 review (s): Vendure refunds only under an enabled method, so a disabled one is refused before any refund.
  it('(s) a refund reaching a disabled Tally method is payment_method_disabled with nothing written, and applies once enabled', async () => {
    const { createPaymentMethod } = await adminClient.query<{ createPaymentMethod: { id: string } }>(parse(`
      mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
      code: 'voucher-card', enabled: true, handler: { code: 'tally-pos', arguments: [{ name: 'tender', value: 'card' }] },
      checker: { code: 'tally-pos', arguments: [] }, translations: [{ languageCode: 'en', name: 'Voucher card', description: '' }] } });
    const enable = (enabled: boolean) => adminClient.query(parse(`mutation Update($input: UpdatePaymentMethodInput!) {
      updatePaymentMethod(input: $input) { id } }`), { input: { id: createPaymentMethod.id, enabled } });
    const session = await openSession();
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800 }]), version: 10 };
    // Tenders are refunded in payment id order, so voucher-card's comes second and cash's refund must roll back with it.
    (command.payload as { payments: unknown[] }).payments = [
      { clientPaymentId: randomUUID(), method: 'cash', amountMinor: 500 },
      { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', methodId: 'voucher-card', amountMinor: command.payload.totalMinor - 500 },
    ];
    const sold = await post(command);
    expect(sold).toMatchObject({ status: 'applied' });
    const order = await readOrder(sold.serverRefs!.orderId);
    const payments = [...order.payments].sort((a, b) => Number(environment.decode(a.id)) - Number(environment.decode(b.id)));
    expect(payments.map(payment => payment.method)).toEqual(['cash', 'voucher-card']);
    await enable(false);
    const createRefund = vi.spyOn(server.app.get(PaymentService), 'createRefund');
    try {
      const refund = refundFor(order, session);
      await refused(refund, order.id, 'payment_method_disabled',
        'Payment method voucher-card is disabled; enable it in the store, then refund again', { paymentId: payments[1].id, method: 'voucher-card' });
      expect(await connection.rawConnection.getRepository(Refund).countBy({ paymentId: In(payments.map(({ id }) => environment.decode(id))) })).toBe(0);
      // Refused before Vendure is asked: it would save a Pending refund under the disabled method.
      expect(createRefund.mock.calls.map(call => String(call[3].id))).toEqual([environment.decode(payments[0].id)]);
    } finally {
      createRefund.mockRestore();
      await enable(true);
    }
    const retry = refundFor(order, session);
    expect(await post(retry)).toEqual({ id: retry.id, status: 'applied', refund: {
      totalMinor: retry.payload.totalMinor, byMethod: { cash: 500, external: retry.payload.totalMinor - 500 },
      refunds: [
        { id: expect.any(String), paymentId: payments[0].id, totalMinor: 500, state: 'Settled' },
        { id: expect.any(String), paymentId: payments[1].id, totalMinor: retry.payload.totalMinor - 500, state: 'Settled' },
      ],
    } });
  });

  // 3.2a-2 fix 2: Vendure resolves a code to an arbitrary one of two enabled methods, and a deleted method leaves no row.
  const createMethod = async (code: string, handler: string) => (await adminClient.query<{ createPaymentMethod: { id: string } }>(parse(`
    mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: { code, enabled: true,
    handler: handler === 'tally-pos' ? { code: handler, arguments: [{ name: 'tender', value: 'card' }] } : { code: handler, arguments: [{ name: 'automaticSettle', value: 'true' }] },
    ...(handler === 'tally-pos' ? { checker: { code: 'tally-pos', arguments: [] } } : {}), translations: [{ languageCode: 'en', name: code, description: '' }] } })).createPaymentMethod.id;
  const removeMethod = (id: string) => adminClient.query(parse('mutation Delete($id: ID!) { deletePaymentMethod(id: $id, force: true) { result } }'), { id });
  async function sellUnder(methodId: string) {
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]), version: 10 };
    const tender = { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', methodId, amountMinor: command.payload.totalMinor };
    (command.payload as { payments: unknown[] }).payments = [tender];
    const result = await post(command);
    expect(result).toMatchObject({ status: 'applied' });
    const order = await readOrder(result.serverRefs!.orderId);
    const payment = await connection.rawConnection.getRepository(Payment).findOneByOrFail({ id: environment.decode(order.payments[0].id) });
    return { result, order, payment, fallback: (reason: string) => ({ code: 'payment_method_fallback', clientPaymentId: tender.clientPaymentId, methodId, reason }) };
  }
  const refundRows = (order: ReadOrder) => connection.rawConnection.getRepository(Refund)
    .countBy({ paymentId: In(order.payments.map(({ id }) => environment.decode(id))) });

  it('(w) a code a Tally and a non-Tally method share is never listed or charged, and its earlier sale\'s refund is refused', async () => {
    const tally = await createMethod('dup', 'tally-pos');
    const session = await openSession();
    const first = await sellUnder('dup');
    expect(first.payment.method).toBe('dup');
    const other = await createMethod('dup', 'dummy-payment-handler');
    try {
      const info = await (await fetch(`${base}/tally/v1/info`, { headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } })).json();
      expect(info.paymentMethods.map((method: { code: string }) => method.code)).toEqual(['card-terminal', 'cash', 'voucher-card']);
      const second = await sellUnder('dup');
      expect(second.result.warnings).toEqual([second.fallback('duplicate_code')]);
      // The dummy handler always sets a transactionId; the Tally handler never does.
      expect([second.payment.method, second.payment.transactionId, second.payment.metadata.tender.methodId]).toEqual(['tally-pos', null, 'dup']);
      await refused(refundFor(first.order, session), first.order.id, 'payment_method_unavailable',
        'Payment method dup shares its code with another payment method in this channel; give one a unique code, then refund again',
        { paymentId: first.order.payments[0].id, method: 'dup' });
      expect(await refundRows(first.order)).toBe(0);
    } finally {
      await removeMethod(other);
      await removeMethod(tally);
    }
  });

  it('(x) once its Tally method is deleted, a sale naming it falls back unknown and an earlier sale\'s refund is refused by name', async () => {
    const gone = await createMethod('gone', 'tally-pos');
    const session = await openSession();
    const sold = await sellUnder('gone');
    expect(sold.payment.method).toBe('gone');
    await removeMethod(gone);
    const later = await sellUnder('gone');
    expect(later.result.warnings).toEqual([later.fallback('unknown')]);
    expect([later.payment.method, later.payment.metadata.tender.methodId]).toEqual(['tally-pos', 'gone']);
    await refused(refundFor(sold.order, session), sold.order.id, 'payment_method_unavailable',
      'Payment method gone no longer exists in this channel; add a Tally POS payment method with code gone, then refund again',
      { paymentId: sold.order.payments[0].id, method: 'gone' });
    expect(await refundRows(sold.order)).toBe(0);
    // 3.2a-2 fix 3: the advice works; a recreated method with that code takes the refund.
    const recreated = await createMethod('gone', 'tally-pos');
    try {
      expect(await post(refundFor(sold.order, session))).toMatchObject({ status: 'applied' });
      const rows = await connection.rawConnection.getRepository(Refund)
        .findBy({ paymentId: In(sold.order.payments.map(({ id }) => environment.decode(id))) });
      expect(rows.map(row => row.state)).toEqual(['Settled']);
    } finally {
      await removeMethod(recreated);
    }
  });
});
