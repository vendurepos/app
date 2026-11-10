import { randomUUID } from 'node:crypto';
import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type ReadOrder = {
  id: string; shippingWithTax: number;
  lines: Array<{ id: string; quantity: number; proratedUnitPriceWithTax: number; proratedLinePriceWithTax: number }>;
};
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };
type Report = {
  orders: { count: number; salesMinor: number; taxMinor: number; discountsMinor: number };
  refunds: { count: number; totalMinor: number };
  byMethod: Array<{ method: string; salesMinor: number; refundsMinor: number }>;
  byDay: Array<{ day: string; orderCount: number; salesMinor: number; refundsMinor: number }>;
} & Record<string, unknown>;

describe('GET /tally/v1/reports/sales', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode } = environment;
  let connection: TransactionalConnection;
  let base: string;
  let till: Record<string, string>;
  let reporter: Record<string, string>;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
    till = await tokenWith(['TallyPosSell', 'TallyPosRefund']);
    reporter = await tokenWith(['TallyPosSell', 'ReadOrder']);
  });
  afterAll(() => server.destroy());

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
    }`), { input: { code: `report-${randomUUID()}`, description: 'Sales report test', permissions, channelIds: [activeChannel.id] } });
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
  const envelope = (type: string, payload: Record<string, unknown>) => ({
    id: randomUUID(), type, version: 1, createdAt: new Date().toISOString(), deviceId: 'report-till', attempt: 1, payload,
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
      id shippingWithTax lines { id quantity proratedUnitPriceWithTax proratedLinePriceWithTax }
    } }`), { id });
    return order;
  }
  // order-refund.e2e.ts's sell, placed in time and on a register.
  async function sell(at: string, registerId: string, options: {
    quantity?: number; method?: 'cash' | 'split'; discountMinor?: number; version?: 3 | 4; sessionId?: string;
  } = {}) {
    const { quantity = 1, method = 'cash', discountMinor, version = 3, sessionId } = options;
    // orderCommand types version as 2 | 3; a v4 payload has the same shape.
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800, ...(discountMinor ? { discountMinor } : {}) }],
      undefined, undefined, { version: version as never, sessionId });
    command.createdAt = at;
    command.payload.createdAt = at;
    command.payload.registerId = registerId;
    command.payload.payments = method === 'split'
      ? [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 500 },
        { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', amountMinor: command.payload.totalMinor - 500 }]
      : [{ clientPaymentId: randomUUID(), method, amountMinor: command.payload.totalMinor }];
    const result = await post(command);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    return { orderId: result.serverRefs!.orderId, payload: command.payload };
  }
  function refundFor(order: ReadOrder, session: { registerId: string; sessionId: string }, overrides: Partial<OrderRefundPayload> = {}): RefundCommand {
    const createdAt = new Date().toISOString();
    const payload = {
      clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt,
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity, restock: true })),
      shippingMinor: order.shippingWithTax, adjustmentMinor: 0, destination: 'original_method' as const, reason: 'Returned at till',
      ...overrides,
    };
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'report-till', attempt: 1,
      payload: { ...payload, totalMinor: overrides.totalMinor ?? payload.lines.reduce((sum, line) => {
        const item = order.lines.find(item => item.id === line.orderLineId)!;
        return item.quantity === 0 ? sum : sum + Math.round(line.quantity * item.proratedLinePriceWithTax / item.quantity);
      }, 0) + payload.shippingMinor + payload.adjustmentMinor } };
  }
  async function report(params: Record<string, string>, token: Record<string, string> = reporter) {
    const response = await fetch(`${base}/tally/v1/reports/sales?${new URLSearchParams(params)}`, { headers: token });
    return { status: response.status, body: await response.json() as Report };
  }
  async function ok(params: Record<string, string>, token?: Record<string, string>) {
    const { status, body } = await report(params, token);
    expect(status, JSON.stringify(body)).toBe(200);
    return body;
  }

  it('totals a register\'s sales, tax and discounts, by method and by day', async () => {
    const registerId = randomUUID();
    const at = '2026-03-10T09:00:00.000Z';
    const first = (await sell(at, registerId, { quantity: 2 })).payload;
    const second = (await sell(at, registerId, { method: 'split', discountMinor: 100, version: 4 })).payload;
    const body = await ok({ from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z', registerId });
    expect(body).toEqual({
      version: 1, from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z', timezone: 'UTC', currencyCode: 'EUR', registerId,
      orders: { count: 2, salesMinor: first.totalMinor + second.totalMinor, taxMinor: first.taxMinor + second.taxMinor, discountsMinor: 100 },
      refunds: { count: 0, totalMinor: 0 },
      byMethod: [
        { method: 'cash', salesMinor: first.totalMinor + 500, refundsMinor: 0 },
        { method: 'external', salesMinor: second.totalMinor - 500, refundsMinor: 0 },
      ],
      byDay: [{ day: '2026-03-10', orderCount: 2, salesMinor: first.totalMinor + second.totalMinor, refundsMinor: 0 }],
    });
  });

  it('buckets days in the requested time zone', async () => {
    const registerId = randomUUID();
    await sell('2026-03-10T23:30:00.000Z', registerId);
    const range = { from: '2026-03-10T00:00:00Z', to: '2026-03-12T00:00:00Z', registerId };
    expect((await ok(range)).byDay.map(entry => entry.day)).toEqual(['2026-03-10']);
    const sydney = await ok({ ...range, timezone: 'Australia/Sydney' });
    expect(sydney.timezone).toBe('Australia/Sydney');
    expect(sydney.byDay.map(entry => entry.day)).toEqual(['2026-03-11']);
  });

  it('includes from and excludes to', async () => {
    const registerId = randomUUID();
    await sell('2026-03-10T10:00:00.000Z', registerId);
    await sell('2026-03-10T11:00:00.000Z', registerId);
    expect((await ok({ from: '2026-03-10T10:00:00Z', to: '2026-03-10T11:00:00Z', registerId })).orders.count).toBe(1);
    expect((await ok({ from: '2026-03-10T11:00:00+01:00', to: '2026-03-10T12:00:00+01:00', registerId })).orders.count).toBe(1);
  });

  it('leaves out rejected, non-POS and other registers\' orders', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const at = '2026-04-01T10:00:00.000Z';
    const rejected = await sell(at, a);
    const nonPos = await sell(at, a);
    await sell(at, a);
    await sell(at, b);
    const orders = connection.rawConnection.getRepository(Order);
    await orders.update(decode(rejected.orderId), { customFields: { tallyRejected: true } });
    await orders.update(decode(nonPos.orderId), { customFields: { tallyClientOrderId: null } });
    const window = { from: '2026-04-01T09:00:00Z', to: '2026-04-01T11:00:00Z' };
    expect((await ok({ ...window, registerId: a })).orders.count).toBe(1);
    const everyRegister = await ok(window);
    expect(everyRegister.registerId).toBeNull();
    expect(everyRegister.orders.count).toBe(2);
  });

  it('counts a till refund on its own date and method', async () => {
    const session = await openSession();
    const saleAt = new Date(Date.now() - 60_000).toISOString();
    const { orderId, payload } = await sell(saleAt, session.registerId, { quantity: 2, sessionId: session.sessionId });
    const order = await readOrder(orderId);
    const line = order.lines[0];
    const refund = refundFor(order, session, { lines: [{ orderLineId: line.id, quantity: 1, restock: true }] });
    expect(await post(refund)).toMatchObject({ status: 'applied' });
    const refundedMinor = refund.payload.totalMinor;
    const now = Date.now();
    const body = await ok({ from: new Date(now - 3_600_000).toISOString(), to: new Date(now + 3_600_000).toISOString(),
      registerId: session.registerId });
    expect(body.refunds).toEqual({ count: 1, totalMinor: refundedMinor });
    expect(body.byMethod).toEqual([{ method: 'cash', salesMinor: payload.totalMinor, refundsMinor: refundedMinor }]);
    // The UTC day of the sale and of the refund; the same day unless the test straddles midnight.
    const expected = new Map<string, Report['byDay'][number]>();
    const day = (at: string) => expected.get(at.slice(0, 10)) ?? expected.set(at.slice(0, 10),
      { day: at.slice(0, 10), orderCount: 0, salesMinor: 0, refundsMinor: 0 }).get(at.slice(0, 10))!;
    Object.assign(day(saleAt), { orderCount: 1, salesMinor: payload.totalMinor });
    day(refund.createdAt).refundsMinor = refundedMinor;
    expect(body.byDay).toEqual([...expected.values()]);
  });

  it('reports only the active channel', async () => {
    const { zones } = await adminClient.query<{ zones: { items: Array<{ id: string; name: string }> } }>(parse('query { zones { items { id name } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) {
        createChannel(input: $input) { ... on Channel { id token } ... on ErrorResult { message } }
      }`), { input: {
      code: 'report-second', token: 'report-second-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    const window = { from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z' };
    const superadmin = { Authorization: `Bearer ${adminClient.getAuthToken()}` };
    // The window holds the default channel's sales from the first test.
    expect((await ok(window, superadmin)).orders.count).toBeGreaterThanOrEqual(2);
    const second = await ok(window, { ...superadmin, 'vendure-token': createChannel.token });
    expect(second.orders.count).toBe(0);
    expect(second.byDay).toEqual([]);
  });

  it('needs TallyPosSell and ReadOrder', async () => {
    const range = { from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z' };
    expect((await report(range, {})).status).toBe(403);
    expect(await report(range, await tokenWith(['TallyPosSell']))).toEqual({ status: 403,
      body: { code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' } });
    expect((await report(range, await tokenWith(['ReadOrder']))).status).toBe(403);
    expect((await report(range)).status).toBe(200);
  });

  it('answers 400 invalid_query for bad parameters', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ to: '2026-03-11T00:00:00Z' }, 'from must be an ISO date-time with an offset'],
      [{ from: '2026-03-10', to: '2026-03-11T00:00:00Z' }, 'from must be an ISO date-time with an offset'],
      [{ from: '2026-03-11T00:00:00Z', to: '2026-03-10T00:00:00Z' }, 'to must be after from'],
      [{ from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' }, 'The range is at most 366 days'],
      [{ from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z', timezone: 'Mars/Olympus' }, 'timezone must be an IANA time zone'],
      [{ from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z', registerId: 'r'.repeat(65) }, 'registerId must be 1 to 64 characters'],
    ];
    for (const [params, message] of cases) {
      expect(await report(params), JSON.stringify(params)).toEqual({ status: 400, body: { code: 'invalid_query', message } });
    }
  });
});
