import { randomUUID } from 'node:crypto';
import { TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import { REFUND_ROUNDING_EXCEEDS_MESSAGE } from '../src/service/refund-line-totals';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type ReadOrder = {
  id: string; shippingWithTax: number;
  lines: Array<{ id: string; quantity: number; proratedLinePriceWithTax: number; productVariant: { id: string } }>;
  surcharges: Array<{ sku: string; priceWithTax: number }>;
  payments: Array<{ id: string; method: string; amount: number; refunds: Array<{
    id: string; total: number; state: string; lines: Array<{ orderLineId: string; quantity: number }>;
  }> }>;
};
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };
type Session = { registerId: string; sessionId: string };

// TallyUI ADR-094 P1c (desk ruling 1, 2026-11-26): the refund that takes everything left on an order's lines returns its
// cash rounding (the TALLY-CASH-ROUNDING surcharge) with it, as it returns the TALLY-ROUNDING bridge; no other refund does.
describe('cash rounding: order.refund (ADR-094 P1c)', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let base: string;
  let refunder: Record<string, string>;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }, { id: variantIds.beans[0], stockOnHand: 1000 }] });
    await adminClient.query(parse(`
      mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
      code: 'cash-5', enabled: true,
      handler: { code: 'tally-pos', arguments: [
        { name: 'tender', value: 'cash' }, { name: 'roundingIncrement', value: '5' }, { name: 'roundingMode', value: 'nearest' }] },
      translations: [{ languageCode: 'en', name: 'cash-5', description: '' }],
    } });
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
    refunder = await tokenWith(['TallyPosSell', 'TallyPosRefund']);
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
  async function openSession(): Promise<Session> {
    const session = { registerId: randomUUID(), sessionId: randomUUID() };
    expect(await post({ id: randomUUID(), type: 'register.session.open', version: 1, createdAt: new Date().toISOString(),
      deviceId: 'refund-till', attempt: 1, payload: { ...session, openedAt: new Date().toISOString(), countedFloatMinor: 0 } }))
      .toMatchObject({ status: 'applied' });
    return session;
  }
  async function readOrder(id: string): Promise<ReadOrder> {
    const { order } = await adminClient.query<{ order: ReadOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      id shippingWithTax lines { id quantity proratedLinePriceWithTax productVariant { id } } surcharges { sku priceWithTax }
      payments { id method amount refunds { id total state lines { orderLineId quantity } } }
    } }`), { id });
    return order;
  }
  function refundFor(order: ReadOrder, session: Session, lines: Array<{ line: ReadOrder['lines'][number]; quantity?: number }>,
    totalMinor: number): RefundCommand {
    const createdAt = new Date().toISOString();
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'refund-till', attempt: 1, payload: {
      clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt,
      lines: lines.map(({ line, quantity }) => ({ orderLineId: line.id, quantity: quantity ?? line.quantity, restock: true })),
      shippingMinor: 0, adjustmentMinor: 0, destination: 'original_method', reason: 'Returned at till', totalMinor,
    } satisfies OrderRefundPayload };
  }
  const everything = (order: ReadOrder, session: Session, totalMinor: number) =>
    refundFor(order, session, order.lines.map(line => ({ line })), totalMinor);
  async function applied(command: RefundCommand, totalMinor: number) {
    expect(await post(command)).toMatchObject({ id: command.id, status: 'applied', refund: { totalMinor } });
  }
  async function refused(command: RefundCommand, orderId: string, code: string, message: string, data?: Record<string, unknown>) {
    const before = (await readOrder(orderId)).payments.flatMap(payment => payment.refunds);
    expect(await post(command)).toEqual({ id: command.id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: command.id })).toBeNull();
    expect((await readOrder(orderId)).payments.flatMap(payment => payment.refunds)).toEqual(before);
  }
  const mismatch = (command: RefundCommand, orderId: string, serverMinor: number) => refused(command, orderId, 'amount_mismatch',
    `Refund total ${command.payload.totalMinor} does not match the server's ${serverMinor}`,
    { expectedMinor: command.payload.totalMinor, serverMinor });
  const refundedOf = async (orderId: string) => (await readOrder(orderId)).payments.flatMap(payment => payment.refunds)
    .filter(refund => refund.state !== 'Failed').reduce((sum, refund) => sum + refund.total, 0);

  /**
   * A v10 sale of catalogue lines (mug, then beans), each priced tax-inclusive so its line total with tax is exactly its
   * gross price under the 25% test catalogue, paid in full on cash-5 with one cashRoundings entry of `cashMinor`.
   * `offset` moves the goods figures off the server's, as order-refund's sellBridged does, for a TALLY-ROUNDING bridge.
   */
  async function sellRounded(lines: Array<{ unitPriceMinor: number; quantity?: number }>, cashMinor: number, offset = 0) {
    const command = { ...orderCommand(lines.map(({ unitPriceMinor, quantity }, index) => ({
      variantId: index ? variantIds.beans[0] : variantIds.mug[0], quantity: quantity ?? 1, unitPriceMinor, taxInclusive: true,
    }))), version: 10 };
    const payload = command.payload as unknown as Record<string, any>;
    if (offset) {
      payload.totalMinor += offset;
      payload.subtotalMinor += offset;
      payload.display.totalMinor += offset;
      payload.display.subtotalMinor += offset;
      payload.display.lines.at(-1).amountMinor += offset;
    }
    const goodsMinor = payload.totalMinor;
    payload.payments = [{ clientPaymentId: randomUUID(), method: 'cash', methodId: 'cash-5', amountMinor: goodsMinor + cashMinor }];
    payload.cashRoundings = [{ paymentId: payload.payments[0].clientPaymentId, minor: cashMinor }];
    payload.totalMinor = goodsMinor + cashMinor;
    payload.display.totalMinor += cashMinor;
    const result = await post(command);
    expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'applied' });
    const order = await readOrder(result.serverRefs!.orderId);
    expect(lines.map((_, index) => order.lines.find(line => line.productVariant.id === (index ? variantIds.beans : variantIds.mug)[0])!
      .proratedLinePriceWithTax)).toEqual(lines.map(({ unitPriceMinor, quantity }) => unitPriceMinor * (quantity ?? 1)));
    expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-CASH-ROUNDING').map(surcharge => surcharge.priceWithTax))
      .toEqual([cashMinor]);
    expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-ROUNDING').map(surcharge => surcharge.priceWithTax))
      .toEqual(offset ? [offset] : []);
    const paid = order.payments.reduce((sum, payment) => sum + payment.amount, 0);
    expect(paid).toBe(payload.totalMinor);
    const line = (variantId: string) => order.lines.find(item => item.productVariant.id === variantId)!;
    return { order, paid, a: line(variantIds.mug[0]), b: line(variantIds.beans[0]) };
  }

  it('R1: a full refund in one go returns a negative cash rounding', async () => {
    const session = await openSession();
    const { order, paid } = await sellRounded([{ unitPriceMinor: 1002 }], -2);
    expect(paid).toBe(1000);
    await applied(everything(order, session, 1000), 1000);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R2: a full refund in one go returns a positive cash rounding', async () => {
    const session = await openSession();
    const { order, paid } = await sellRounded([{ unitPriceMinor: 1003 }], 2);
    expect(paid).toBe(1005);
    await applied(everything(order, session, 1005), 1005);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R3: line by line, the refund that takes the last line carries a negative cash rounding', async () => {
    const session = await openSession();
    const { order, paid, a, b } = await sellRounded([{ unitPriceMinor: 600 }, { unitPriceMinor: 402 }], -2);
    expect(paid).toBe(1000);
    await applied(refundFor(order, session, [{ line: a }], 600), 600);
    await mismatch(refundFor(order, session, [{ line: b }], 402), order.id, 400);
    await applied(refundFor(order, session, [{ line: b }], 400), 400);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R4: line by line, the last line carries a positive cash rounding', async () => {
    const session = await openSession();
    const { order, paid, a, b } = await sellRounded([{ unitPriceMinor: 600 }, { unitPriceMinor: 403 }], 2);
    expect(paid).toBe(1005);
    await applied(refundFor(order, session, [{ line: a }], 600), 600);
    await applied(refundFor(order, session, [{ line: b }], 405), 405);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R5: by quantity, the last unit carries the cash rounding', async () => {
    const session = await openSession();
    const { order, paid, a } = await sellRounded([{ unitPriceMinor: 501, quantity: 2 }], -2);
    expect(paid).toBe(1000);
    await applied(refundFor(order, session, [{ line: a, quantity: 1 }], 501), 501);
    await applied(refundFor(order, session, [{ line: a, quantity: 1 }], 499), 499);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R6: a partial refund returns none of the cash rounding', async () => {
    const session = await openSession();
    const { order, a } = await sellRounded([{ unitPriceMinor: 600 }, { unitPriceMinor: 402 }], -2);
    await mismatch(refundFor(order, session, [{ line: a }], 598), order.id, 600);
  });

  it('R7: the full refund returns the TALLY-ROUNDING bridge and the cash rounding together', async () => {
    const session = await openSession();
    const { order, paid } = await sellRounded([{ unitPriceMinor: 1000 }, { unitPriceMinor: 503 }], -2, -1);
    expect(paid).toBe(1503 - 3);
    // Lines and cash rounding without the bridge (1501) is not the server's figure.
    await mismatch(everything(order, session, 1501), order.id, 1500);
    await applied(everything(order, session, paid), paid);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R8 (vendurepos/app#469): when the last line nets to 0, its refund is rounding_exceeds_rest and its quantity stays unrefunded', async () => {
    const session = await openSession();
    const { order, paid, a, b } = await sellRounded([{ unitPriceMinor: 1000 }, { unitPriceMinor: 2 }], -2);
    expect(paid).toBe(1000);
    await applied(refundFor(order, session, [{ line: a }], 1000), 1000);
    await refused(refundFor(order, session, [{ line: b }], 0), order.id, 'rounding_exceeds_rest', REFUND_ROUNDING_EXCEEDS_MESSAGE,
      { roundingMinor: -2, restMinor: 2 });
    expect(await refundedOf(order.id)).toBe(paid);
    expect((await readOrder(order.id)).payments.flatMap(payment => payment.refunds).flatMap(refund => refund.lines)
      .filter(line => line.orderLineId === b.id)).toEqual([]);
  });

  it('R9: a partial refund above what was paid is refused amount_mismatch, and everything is then refundable', async () => {
    const session = await openSession();
    const { order, paid, b } = await sellRounded([{ unitPriceMinor: 1 }, { unitPriceMinor: 1001 }], -2);
    expect(paid).toBe(1000);
    await mismatch(refundFor(order, session, [{ line: b }], 1001), order.id, 1000);
    await applied(everything(order, session, 1000), 1000);
    expect(await refundedOf(order.id)).toBe(paid);
  });

  it('R10: the bridge and cash rounding together consume the last line and its refund is refused rounding_exceeds_rest', async () => {
    const session = await openSession();
    const { order, paid, a, b } = await sellRounded([{ unitPriceMinor: 1000 }, { unitPriceMinor: 3 }], -1, -2);
    expect(paid).toBe(1000);
    await applied(refundFor(order, session, [{ line: a }], 1000), 1000);
    await refused(refundFor(order, session, [{ line: b }], 0), order.id, 'rounding_exceeds_rest', REFUND_ROUNDING_EXCEEDS_MESSAGE,
      { roundingMinor: -3, restMinor: 3 });
    expect(await refundedOf(order.id)).toBe(paid);
  });
});
