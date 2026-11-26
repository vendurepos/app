import { randomUUID } from 'node:crypto';
import { Refund, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TallySalesReportV3, TallySalesReportV4 } from '../src/service/report.service';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type ReadOrder = {
  id: string;
  lines: Array<{ id: string; quantity: number; proratedLinePriceWithTax: number; productVariant: { id: string } }>;
  surcharges: Array<{ sku: string; priceWithTax: number }>;
  payments: Array<{ id: string; method: string; amount: number; refunds: Array<{
    id: string; total: number; state: string; metadata: Record<string, unknown>; lines: Array<{ orderLineId: string; quantity: number }>;
  }> }>;
};
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };
type Session = { registerId: string; sessionId: string };
type Sale = { at: string; registerId: string; cashierRef: string };
type Leg = { methodId: 'cash-5' | 'card'; method: 'cash' | 'external'; amountMinor: number; minor?: number };
type Filter = { registerId?: string; cashierId?: string };
type CashRounding = TallySalesReportV4['cashRounding'];

const HOUR = 3_600_000;
const MINUTE = 60_000;
const ZERO: CashRounding = { salesMinor: 0, orderCount: 0, unexplainedOrderCount: 0, refundedMinor: 0, refundCount: 0, netMinor: 0 };

describe('GET /tally/v1/reports/sales/v4: dashboard refunds (#513)', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let base: string;
  let till: Record<string, string>;
  let reporter: Record<string, string>;
  const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
  const sessions: Record<string, Session> = {};
  let all: { from: string; to: string };
  let salesOnly: { from: string; to: string };
  let refundsOnly: { from: string; to: string };
  let partialOnly: { from: string; to: string };
  const results: Record<string, CommandResult> = {};
  const orders: Record<string, ReadOrder> = {};
  const refundResults: Record<string, CommandResult> = {};
  let keyedId: string;

  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }, { id: variantIds.beans[0], stockOnHand: 1000 }] });
    await createMethod('cash-5', { tender: 'cash', roundingIncrement: '5', roundingMode: 'nearest' });
    await createMethod('card', { tender: 'card' });
    base = await server.app.getUrl();
    till = await tokenWith(['TallyPosSell', 'TallyPosRefund']);
    reporter = await tokenWith(['TallyPosSell', 'ReadOrder']);
    for (const registerId of [A, B, C]) sessions[registerId] = await openSession(registerId);

    const now = Date.now();
    all = { from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now + HOUR).toISOString() };
    salesOnly = { from: all.from, to: new Date(now - HOUR).toISOString() };
    partialOnly = { from: new Date(now - 100 * MINUTE).toISOString(), to: new Date(now - 80 * MINUTE).toISOString() };
    const sale = (minutes: number, registerId: string, cashierRef = 'cashier-2'): Sale =>
      ({ at: new Date(now - 2 * HOUR + minutes * MINUTE).toISOString(), registerId, cashierRef });
    await sellRounded('D1', sale(0, A, 'cashier-1'), [{ unitPriceMinor: 1002 }], -2);
    await sellRounded('D2', sale(1, A), [{ unitPriceMinor: 998 }], 2);
    await sellRounded('D3', sale(2, B), [{ unitPriceMinor: 499 }, { unitPriceMinor: 503 }], -2);
    await sellRounded('D5', sale(3, C), [{ unitPriceMinor: 1003 }], 2);
    await sellRounded('D6', sale(4, A), [{ unitPriceMinor: 1000 }], 0);
    await sellRounded('D7', sale(5, B), [{ unitPriceMinor: 1004 }], 1, 0,
      [{ methodId: 'card', method: 'external', amountMinor: 500 }, { methodId: 'cash-5', method: 'cash', amountMinor: 505, minor: 1 }]);
    await sellRounded('D8', sale(6, A), [{ unitPriceMinor: 1002 }], -2);

    const repo = server.app.get(TransactionalConnection).rawConnection.getRepository(Refund);
    refundsOnly = { from: new Date(Date.now() - MINUTE).toISOString(), to: all.to };
    await dashboardRefund('D1', 'cash-5', 1000);
    const partial = await dashboardRefund('D2', 'cash-5', 400);
    await repo.update(environment.decode(partial), { createdAt: () => `TIMESTAMPTZ '${new Date(now - 90 * MINUTE).toISOString()}' AT TIME ZONE current_setting('TimeZone')` });
    await dashboardRefund('D2', 'cash-5', 600);
    const mug = orders.D3.lines.find(item => item.productVariant.id === variantIds.mug[0])!;
    await refund('partial', 'D3', B, [{ line: mug }], 499);
    await dashboardRefund('D3', 'cash-5', 501);
    keyedId = await dashboardRefund('D5', 'cash-5', 500);
    await repo.update(environment.decode(keyedId), { metadata: () => `'{"tallyCashRoundingMinor":2}'` });
    await dashboardRefund('D5', 'cash-5', 505);
    await dashboardRefund('D6', 'cash-5', 1000);
    await dashboardRefund('D7', 'card', 500);
    await dashboardRefund('D7', 'cash-5', 505);
    const failed = await dashboardRefund('D8', 'cash-5', 1000);
    await repo.update(environment.decode(failed), { state: 'Failed' });
    await dashboardRefund('D8', 'cash-5', 1000);
    for (const name of Object.keys(orders)) orders[name] = await readOrder(orders[name].id);
  });
  afterAll(() => server.destroy());

  async function dashboardRefund(sale: string, method: string, amount: number): Promise<string> {
    const paymentId = orders[sale].payments.find(payment => payment.method === method)!.id;
    const { refundOrder } = await adminClient.query<{ refundOrder: { id: string; total: number; state: string } }>(parse(`mutation Refund($input: RefundOrderInput!) {
      refundOrder(input: $input) { ... on Refund { id total state } ... on ErrorResult { errorCode message } }
    }`), { input: { paymentId, amount, shipping: 0, adjustment: 0, reason: 'Back office' } });
    expect(refundOrder).toMatchObject({ total: amount, state: 'Settled' });
    return refundOrder.id;
  }

  async function createMethod(code: string, args: Record<string, string>) {
    await adminClient.query(parse(`
      mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
      code, enabled: true,
      handler: { code: 'tally-pos', arguments: Object.entries(args).map(([name, value]) => ({ name, value })) },
      translations: [{ languageCode: 'en', name: code, description: '' }],
    } });
  }
  const headers = (token: Record<string, string>) => ({ 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...token });
  async function post(command: unknown, token = till): Promise<CommandResult> {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ commands: [command] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).results[0];
  }
  async function tokenWith(permissions: string[]) {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `report-${randomUUID()}`, description: 'Sales report v4 test', permissions, channelIds: [activeChannel.id] } });
    const emailAddress = `${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: 'Report', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
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
  async function openSession(registerId: string): Promise<Session> {
    const session = { registerId, sessionId: randomUUID() };
    expect(await post({ id: randomUUID(), type: 'register.session.open', version: 1, createdAt: new Date().toISOString(),
      deviceId: 'report-till', attempt: 1, payload: { ...session, openedAt: new Date().toISOString(), countedFloatMinor: 0 } }))
      .toMatchObject({ status: 'applied' });
    return session;
  }
  async function readOrder(id: string): Promise<ReadOrder> {
    const { order } = await adminClient.query<{ order: ReadOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      id lines { id quantity proratedLinePriceWithTax productVariant { id } } surcharges { sku priceWithTax }
      payments { id method amount refunds { id total state metadata lines { orderLineId quantity } } }
    } }`), { id });
    return order;
  }
  function refundFor(order: ReadOrder, session: Session, lines: Array<{ line: ReadOrder['lines'][number]; quantity?: number }>,
    totalMinor: number): RefundCommand {
    const createdAt = new Date().toISOString();
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'report-till', attempt: 1, payload: {
      clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt,
      lines: lines.map(({ line, quantity }) => ({ orderLineId: line.id, quantity: quantity ?? line.quantity, restock: true })),
      shippingMinor: 0, adjustmentMinor: 0, destination: 'original_method', reason: 'Returned at till', totalMinor,
    } satisfies OrderRefundPayload };
  }
  async function refund(name: string, sale: string, registerId: string, lines: Array<{ line: ReadOrder['lines'][number] }>, totalMinor: number) {
    const command = refundFor(orders[sale], sessions[registerId], lines, totalMinor);
    const result = await post(command);
    expect(result, JSON.stringify(result.error)).toMatchObject({ id: command.id, status: 'applied', refund: { totalMinor } });
    refundResults[name] = result;
  }

  /**
   * A v10 sale at `sale.at` on its register and cashier, of catalogue lines (mug, then beans), each priced tax-inclusive so its
   * line total with tax is exactly its gross price. Without `legs`, it is paid in full on one cash-5 leg carrying one
   * cashRoundings entry of `cashMinor` (none when 0); with `legs`, by those, each with its own entry when it names `minor`.
   * `offset` moves the goods figures off the server's, as order-refund's sellBridged does, for a TALLY-ROUNDING bridge.
   * `more.edit` changes the payload before it is sent; `more.into` keeps the result out of `results` (S1–S6).
   */
  async function sellRounded(name: string, sale: Sale, lines: Array<{ unitPriceMinor: number; quantity?: number; discountMinor?: number }>,
    cashMinor: number, offset = 0, legs?: Leg[],
    more: { edit?: (payload: Record<string, any>) => void; into?: Record<string, CommandResult> } = {}) {
    const command = { ...orderCommand(lines.map(({ unitPriceMinor, quantity, discountMinor }, index) => ({
      variantId: index ? variantIds.beans[0] : variantIds.mug[0], quantity: quantity ?? 1, unitPriceMinor, taxInclusive: true,
      ...(discountMinor ? { discountMinor } : {}),
    }))), version: 10, createdAt: sale.at };
    const payload = command.payload as unknown as Record<string, any>;
    Object.assign(payload, { createdAt: sale.at, registerId: sale.registerId, cashierRef: sale.cashierRef });
    more.edit?.(payload);
    if (offset) {
      payload.totalMinor += offset;
      payload.subtotalMinor += offset;
      payload.display.totalMinor += offset;
      payload.display.subtotalMinor += offset;
      payload.display.lines.at(-1).amountMinor += offset;
    }
    const goodsMinor = payload.totalMinor;
    const tenders: Leg[] = legs ?? [{ methodId: 'cash-5', method: 'cash', amountMinor: goodsMinor + cashMinor, ...(cashMinor ? { minor: cashMinor } : {}) }];
    payload.payments = tenders.map(({ minor, ...tender }) => ({ clientPaymentId: randomUUID(), ...tender }));
    const entries = tenders.flatMap((tender, index) => tender.minor === undefined ? []
      : [{ paymentId: payload.payments[index].clientPaymentId, minor: tender.minor }]);
    if (entries.length) payload.cashRoundings = entries;
    payload.totalMinor = goodsMinor + cashMinor;
    payload.display.totalMinor += cashMinor;
    const result = await post(command);
    expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'applied' });
    const order = await readOrder(result.serverRefs!.orderId);
    expect(lines.map((_, index) => order.lines.find(line => line.productVariant.id === (index ? variantIds.beans : variantIds.mug)[0])!
      .proratedLinePriceWithTax)).toEqual(lines.map(({ unitPriceMinor, quantity }) => unitPriceMinor * (quantity ?? 1)));
    expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-CASH-ROUNDING').map(surcharge => surcharge.priceWithTax))
      .toEqual(cashMinor ? [cashMinor] : []);
    expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-ROUNDING').map(surcharge => surcharge.priceWithTax))
      .toEqual(offset ? [offset] : []);
    expect(order.payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(payload.totalMinor);
    (more.into ?? results)[name] = result;
    orders[name] = order;
  }

  async function report(path: string, params: Record<string, string>, token: Record<string, string> = reporter) {
    const response = await fetch(`${base}/tally/v1/${path}?${new URLSearchParams({ timezone: 'UTC', ...params })}`, { headers: token });
    return { status: response.status, body: await response.json() };
  }
  async function v4(range: { from: string; to: string }, filter: Filter = {}): Promise<TallySalesReportV4> {
    const { status, body } = await report('reports/sales/v4', { ...range, ...filter });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.version).toBe(4);
    return body;
  }
  const refundsOf = (sale: string) => orders[sale].payments.flatMap(payment => payment.refunds);
  const metadataOf = (sale: string, refundId: string) => refundsOf(sale).find(item => item.id === refundId)!.metadata;
  const refundIds = (name: string) => refundResults[name].refund!.refunds.map(item => item.id);

  it('D0: all sales applied without unexplained rounding; only the marked D5 refund has a rounding key', () => {
    expect(Object.keys(results)).toEqual(['D1', 'D2', 'D3', 'D5', 'D6', 'D7', 'D8']);
    for (const [name, result] of Object.entries(results)) {
      expect(result.status, name).toBe('applied');
      expect(result.warnings ?? [], name).not.toContainEqual(expect.objectContaining({ code: 'cash_rounding_unexplained' }));
      const keyed = refundsOf(name).filter(item => 'tallyCashRoundingMinor' in item.metadata).map(item => item.id);
      expect(keyed, name).toEqual(name === 'D5' ? [keyedId] : []);
    }
    expect(metadataOf('D5', keyedId).tallyCashRoundingMinor).toBe(2);
    expect(refundIds('partial')).toHaveLength(1);
  });

  it('X1: all sales and refunds', async () => {
    expect((await v4(all)).cashRounding).toEqual({ salesMinor: -1, orderCount: 6, unexplainedOrderCount: 0, refundedMinor: -1, refundCount: 6, netMinor: 0 });
  });

  it('X2: the refund window includes D2’s completing refund but not its first partial', async () => {
    expect((await v4(refundsOnly)).cashRounding).toEqual({ salesMinor: 0, orderCount: 0, unexplainedOrderCount: 0, refundedMinor: -1, refundCount: 6, netMinor: 1 });
  });

  it('X3: the sales window includes no returned rounding', async () => {
    expect((await v4(salesOnly)).cashRounding).toEqual({ salesMinor: -1, orderCount: 6, unexplainedOrderCount: 0, refundedMinor: 0, refundCount: 0, netMinor: -1 });
  });

  it('X4: register A excludes the unrounded sale and the failed refund', async () => {
    expect((await v4(all, { registerId: A })).cashRounding).toEqual({ salesMinor: -2, orderCount: 3, unexplainedOrderCount: 0, refundedMinor: -2, refundCount: 3, netMinor: 0 });
  });

  it('X5: register B counts one return each for the mixed-source and split-payment refunds', async () => {
    expect((await v4(all, { registerId: B })).cashRounding).toEqual({ salesMinor: -1, orderCount: 2, unexplainedOrderCount: 0, refundedMinor: -1, refundCount: 2, netMinor: 0 });
  });

  it('X6: register C counts the explicit key only', async () => {
    expect((await v4(all, { registerId: C })).cashRounding).toEqual({ salesMinor: 2, orderCount: 1, unexplainedOrderCount: 0, refundedMinor: 2, refundCount: 1, netMinor: 0 });
  });

  it('X7: the dashboard refund falls back to the sale’s cashier', async () => {
    expect((await v4(all, { cashierId: 'cashier-1' })).cashRounding).toEqual({ salesMinor: -2, orderCount: 1, unexplainedOrderCount: 0, refundedMinor: -2, refundCount: 1, netMinor: 0 });
  });

  it('X8: v4 is v3 plus cashRounding', async () => {
    const { version, cashRounding, ...four } = await v4(all);
    const three = await report('reports/sales/v3', all);
    expect(three.status).toBe(200);
    const { version: threeVersion, ...rest } = three.body as TallySalesReportV3;
    expect([version, threeVersion]).toEqual([4, 3]);
    expect('cashRounding' in three.body).toBe(false);
    expect(cashRounding).toBeDefined();
    expect(four).toEqual(rest);
  });

  it('X9: the earlier partial alone returns no rounding', async () => {
    expect((await v4(partialOnly)).cashRounding).toEqual(ZERO);
  });
});
