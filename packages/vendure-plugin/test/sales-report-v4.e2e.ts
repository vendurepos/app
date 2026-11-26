import { randomUUID } from 'node:crypto';
import { Order, TransactionalConnection } from '@vendure/core';
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

/**
 * TallyUI ADR-094 P2: the v4 sales report's cash rounding, and the refund metadata (tallyCashRoundingMinor) it reads.
 * Six sales over four registers (S3 has no cashRoundings, S5 a cash_rounding_unexplained write-off, S6 a TALLY-ROUNDING
 * bridge too) and five refunds (RF2 then RF3 is the partial-then-final case).
 * Three early sales on register E, outside every other range (#514): U1 has a discount label cut mid-emoji (a lone surrogate,
 * stored as the escape \ud83d), U2 card −3 and cash +3, a cash_rounding_unexplained warning with no surcharge, U3 a discount
 * labelled exactly cashRoundingUnexplained, which passes the LIKE pre-filter but is not a top-level key.
 * Known not covered:
 * - a Failed refund: a Tally refund is always Settled, and posRefunds already excludes Failed;
 * - a Vendure-dashboard refund: it has no Tally context, so it never carries the key, and its rounding is not counted as returned.
 */
describe('GET /tally/v1/reports/sales/v4 (ADR-094 P2)', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let base: string;
  let till: Record<string, string>;
  let reporter: Record<string, string>;
  const [A, B, C, D, E] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const sessions: Record<string, Session> = {};
  let all: { from: string; to: string };
  let salesOnly: { from: string; to: string };
  let refundsOnly: { from: string; to: string };
  let early: { from: string; to: string };
  let connection: TransactionalConnection;
  const results: Record<string, CommandResult> = {};
  const orders: Record<string, ReadOrder> = {};
  const refundResults: Record<string, CommandResult> = {};
  const earlyResults: Record<string, CommandResult> = {};

  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }, { id: variantIds.beans[0], stockOnHand: 1000 }] });
    await createMethod('cash-5', { tender: 'cash', roundingIncrement: '5', roundingMode: 'nearest' });
    await createMethod('card', { tender: 'card' });
    base = await server.app.getUrl();
    connection = server.app.get(TransactionalConnection);
    till = await tokenWith(['TallyPosSell', 'TallyPosRefund']);
    reporter = await tokenWith(['TallyPosSell', 'ReadOrder']);
    for (const registerId of [A, B, C, D, E]) sessions[registerId] = await openSession(registerId);

    const now = Date.now();
    all = { from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now + HOUR).toISOString() };
    salesOnly = { from: all.from, to: new Date(now - HOUR).toISOString() };
    const sale = (minutes: number, registerId: string, cashierRef: string): Sale =>
      ({ at: new Date(now - 2 * HOUR + minutes * MINUTE).toISOString(), registerId, cashierRef });
    await sellRounded('S1', sale(0, A, 'cashier-1'), [{ unitPriceMinor: 1002 }], -2);
    await sellRounded('S2', sale(1, A, 'cashier-2'), [{ unitPriceMinor: 499 }, { unitPriceMinor: 499 }], 2);
    await sellRounded('S3', sale(2, D, 'cashier-2'), [{ unitPriceMinor: 1000 }], 0);
    await sellRounded('S4', sale(3, B, 'cashier-1'), [{ unitPriceMinor: 1004 }], 1, 0,
      [{ methodId: 'card', method: 'external', amountMinor: 500 }, { methodId: 'cash-5', method: 'cash', amountMinor: 505, minor: 1 }]);
    await sellRounded('S5', sale(4, B, 'cashier-2'), [{ unitPriceMinor: 1003 }], -3, 0,
      [{ methodId: 'card', method: 'external', amountMinor: 1000, minor: -3 }]);
    await sellRounded('S6', sale(5, C, 'cashier-2'), [{ unitPriceMinor: 1000 }, { unitPriceMinor: 503 }], -2, -1);
    early = { from: new Date(now - 31 * HOUR).toISOString(), to: new Date(now - 29 * HOUR).toISOString() };
    const earlySale = (minutes: number): Sale => ({ at: new Date(now - 30 * HOUR + minutes * MINUTE).toISOString(), registerId: E, cashierRef: 'cashier-3' });
    await sellRounded('U1', earlySale(0), [{ unitPriceMinor: 1002, discountMinor: 100 }], -2, 0, undefined, {
      // orderCommand figures the 100 in the line's (inclusive) mode; from v4 the wire discountMinor is net, 80 at 25 %.
      into: earlyResults, edit: payload => {
        payload.discountMinor = payload.lines[0].discountMinor = 80;
        payload.display.lines[0].discounts[0].label = 'Staff X';
      } });
    // #515: the envelope now refuses a lone surrogate, so U1's stored snapshot gets the escape directly, as a sale stored before #515 holds it.
    const u1 = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: environment.decode(orders.U1.id) });
    await connection.rawConnection.getRepository(Order).update(u1.id, { customFields: {
      tallySnapshot: (u1.customFields.tallySnapshot as string).replace('"label":"Staff X"', String.raw`"label":"Staff \ud83d"`),
    } });
    await sellRounded('U2', earlySale(1), [{ unitPriceMinor: 1000 }], 0, 0, [{ methodId: 'card', method: 'external', amountMinor: 495, minor: -3 },
      { methodId: 'cash-5', method: 'cash', amountMinor: 505, minor: 3 }], { into: earlyResults });
    await sellRounded('U3', earlySale(2), [{ unitPriceMinor: 1002, discountMinor: 100 }], -2, 0, undefined, {
      into: earlyResults, edit: payload => {
        payload.discountMinor = payload.lines[0].discountMinor = 80;
        payload.display.lines[0].discounts[0].label = 'cashRoundingUnexplained';
      } });

    // The refunds are made now, after the sales; the refund window opens a minute before RF1, well after the last sale,
    // so a small clock difference between Node and the Postgres container cannot drop a refund from it.
    refundsOnly = { from: new Date(Date.now() - MINUTE).toISOString(), to: all.to };
    const line = (sale: string, variant: 'mug' | 'beans') => orders[sale].lines.find(item => item.productVariant.id === variantIds[variant][0])!;
    await refund('RF1', 'S1', A, orders.S1.lines.map(item => ({ line: item })), 1000);
    await refund('RF2', 'S2', A, [{ line: line('S2', 'mug') }], 499);
    await refund('RF3', 'S2', A, [{ line: line('S2', 'beans') }], 501);
    await refund('RF4', 'S4', B, orders.S4.lines.map(item => ({ line: item })), 1005);
    await refund('RF5', 'S6', C, orders.S6.lines.map(item => ({ line: item })), 1500);
    for (const name of Object.keys(orders)) orders[name] = await readOrder(orders[name].id);
  });
  afterAll(() => server.destroy());

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

  it('S1–S6: every sale is applied, and only S5 warns cash_rounding_unexplained, once', () => {
    for (const [name, result] of Object.entries(results)) {
      expect(result.status, name).toBe('applied');
      const unexplained = ((result.warnings ?? []) as Array<{ code: string }>).filter(warning => warning.code === 'cash_rounding_unexplained');
      expect(unexplained, name).toHaveLength(name === 'S5' ? 1 : 0);
    }
    expect(Object.keys(results)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('RF1: S1 in full records −2 on its one Refund', () => {
    expect(refundIds('RF1')).toHaveLength(1);
    expect(metadataOf('S1', refundIds('RF1')[0]).tallyCashRoundingMinor).toBe(-2);
  });

  it('RF2 then RF3: the partial refund records none, and the final one records all (+2)', () => {
    expect(refundIds('RF2')).toHaveLength(1);
    expect('tallyCashRoundingMinor' in metadataOf('S2', refundIds('RF2')[0])).toBe(false);
    expect(refundIds('RF3')).toHaveLength(1);
    expect(metadataOf('S2', refundIds('RF3')[0]).tallyCashRoundingMinor).toBe(2);
  });

  it('RF4: S4 in full, card and cash, records +1 on the command\'s first Refund only', () => {
    const [first, second] = refundIds('RF4');
    expect(refundIds('RF4')).toHaveLength(2);
    expect(refundsOf('S4').map(item => item.total).sort((a, b) => a - b)).toEqual([500, 505]);
    expect(metadataOf('S4', first).tallyCashRoundingMinor).toBe(1);
    expect('tallyCashRoundingMinor' in metadataOf('S4', second)).toBe(false);
  });

  it('RF5: S6 in full returns the bridge and the cash rounding (1500), and records only the cash part (−2)', () => {
    expect(refundResults.RF5.refund!.totalMinor).toBe(1500);
    expect(refundIds('RF5')).toHaveLength(1);
    expect(metadataOf('S6', refundIds('RF5')[0]).tallyCashRoundingMinor).toBe(-2);
  });

  it('T1: the whole range', async () => {
    expect((await v4(all)).cashRounding).toEqual({ salesMinor: -4, orderCount: 5, unexplainedOrderCount: 1, refundedMinor: -1, refundCount: 4, netMinor: -3 });
  });

  it('T2: register B', async () => {
    expect((await v4(all, { registerId: B })).cashRounding).toEqual({ salesMinor: -2, orderCount: 2, unexplainedOrderCount: 1, refundedMinor: 1, refundCount: 1, netMinor: -3 });
  });

  it('T3: register A', async () => {
    expect((await v4(all, { registerId: A })).cashRounding).toEqual({ salesMinor: 0, orderCount: 2, unexplainedOrderCount: 0, refundedMinor: 0, refundCount: 2, netMinor: 0 });
  });

  it('T4: register D, whose one sale has no cashRoundings (flag off), is all 0', async () => {
    expect((await v4(all, { registerId: D })).cashRounding).toEqual(ZERO);
  });

  it('T5: register C, the bridged sale: the bridge is in neither figure', async () => {
    expect((await v4(all, { registerId: C })).cashRounding).toEqual({ salesMinor: -2, orderCount: 1, unexplainedOrderCount: 0, refundedMinor: -2, refundCount: 1, netMinor: 0 });
  });

  it('T6: cashier-1 sold S1 and S4; the refunds are refund-cashier\'s', async () => {
    expect((await v4(all, { cashierId: 'cashier-1' })).cashRounding).toEqual({ salesMinor: -1, orderCount: 2, unexplainedOrderCount: 0, refundedMinor: 0, refundCount: 0, netMinor: -1 });
  });

  it('T7: refund-cashier made every refund and no sale', async () => {
    expect((await v4(all, { cashierId: 'refund-cashier' })).cashRounding).toEqual({ salesMinor: 0, orderCount: 0, unexplainedOrderCount: 0, refundedMinor: -1, refundCount: 4, netMinor: 1 });
  });

  it('T8: a range of the sales only', async () => {
    expect((await v4(salesOnly)).cashRounding).toEqual({ salesMinor: -4, orderCount: 5, unexplainedOrderCount: 1, refundedMinor: 0, refundCount: 0, netMinor: -4 });
  });

  it('T9: a range of the refunds only, dated by the refund', async () => {
    expect((await v4(refundsOnly)).cashRounding).toEqual({ salesMinor: 0, orderCount: 0, unexplainedOrderCount: 0, refundedMinor: -1, refundCount: 4, netMinor: 1 });
  });

  it('T10: v4 is v3 plus cashRounding, and v3 has no cashRounding key', async () => {
    const cases: Array<[{ from: string; to: string }, Filter]> = [[all, {}], [all, { registerId: B }], [all, { cashierId: 'cashier-1' }], [refundsOnly, {}]];
    for (const [range, filter] of cases) {
      const { version, cashRounding, ...four } = await v4(range, filter);
      const three = await report('reports/sales/v3', { ...range, ...filter });
      expect(three.status).toBe(200);
      const { version: threeVersion, ...rest } = three.body as TallySalesReportV3;
      expect([version, threeVersion]).toEqual([4, 3]);
      expect('cashRounding' in three.body).toBe(false);
      expect(cashRounding).toBeDefined();
      expect(four, JSON.stringify(filter)).toEqual(rest);
    }
  });

  it('U1: the lone-surrogate sale is applied, and its stored snapshot keeps the escape \\ud83d', async () => {
    expect(earlyResults.U1.status).toBe('applied');
    const { customFields } = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: environment.decode(orders.U1.id) });
    expect(customFields.tallySnapshot).toContain('\\ud83d');
  });

  it('U2: card −3 and cash +3 net to 0: applied, one cash_rounding_unexplained warning, no TALLY-CASH-ROUNDING surcharge', () => {
    expect(earlyResults.U2.status).toBe('applied');
    expect(((earlyResults.U2.warnings ?? []) as Array<{ code: string }>).filter(warning => warning.code === 'cash_rounding_unexplained'))
      .toHaveLength(1);
    expect(orders.U2.surcharges.filter(surcharge => surcharge.sku === 'TALLY-CASH-ROUNDING')).toEqual([]);
  });

  it('U3: the label cashRoundingUnexplained is applied with no warning, passes the LIKE, and is no top-level key', async () => {
    expect(earlyResults.U3.status).toBe('applied');
    expect(((earlyResults.U3.warnings ?? []) as Array<{ code: string }>).filter(warning => warning.code === 'cash_rounding_unexplained'))
      .toEqual([]);
    const { customFields } = await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: environment.decode(orders.U3.id) });
    expect(customFields.tallySnapshot).toContain('"cashRoundingUnexplained"');
    expect(Object.hasOwn(JSON.parse(customFields.tallySnapshot as string), 'cashRoundingUnexplained')).toBe(false);
  });

  it('T12: the early range, U1, U2 and U3: v4 answers 200 with only U2 unexplained, and is v3 plus cashRounding', async () => {
    const expected: CashRounding = { salesMinor: -4, orderCount: 2, unexplainedOrderCount: 1, refundedMinor: 0, refundCount: 0, netMinor: -4 };
    expect((await v4(early)).cashRounding).toEqual(expected);
    expect((await v4(early, { registerId: E })).cashRounding).toEqual(expected);
    const three = await report('reports/sales/v3', early);
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    const { version, cashRounding, ...four } = await v4(early);
    const { version: threeVersion, ...rest } = three.body as TallySalesReportV3;
    expect([version, threeVersion, cashRounding]).toEqual([4, 3, expected]);
    expect(four).toEqual(rest);
  });

  it('T11: has v3\'s permission and query answers', async () => {
    expect((await report('reports/sales/v4', all, {})).status).toBe(403);
    expect(await report('reports/sales/v4', all, await tokenWith(['TallyPosSell']))).toEqual({ status: 403,
      body: { code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' } });
    expect(await report('reports/sales/v4', { ...all, cashierId: '' })).toEqual({ status: 400,
      body: { code: 'invalid_query', message: 'cashierId must be 1 to 64 characters' } });
    expect(await report('reports/sales/v4', { to: all.to })).toEqual({ status: 400,
      body: { code: 'invalid_query', message: 'from must be an ISO date-time with an offset' } });
  });
});
