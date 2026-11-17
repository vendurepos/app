import { randomUUID } from 'node:crypto';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TallySalesReport, TallySalesReportV2 } from '../src/service/report.service';
import type { CommandResult, OrderRefundEnvelope, OrderRefundPayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// An order as Vendure's Admin API reads it back: the raw material every expected figure is derived from.
type RawOrder = {
  id: string; subTotal: number; subTotalWithTax: number; shipping: number; shippingWithTax: number;
  customFields: { tallySaleAt: string; tallyRegisterId: string; tallyCashierRef: string };
  lines: Array<{ id: string; quantity: number; proratedLinePriceWithTax: number; productVariant: { id: string; sku: string; name: string } }>;
  surcharges: Array<{ sku: string; price: number }>;
  taxSummary: Array<{ description: string; taxRate: number; taxBase: number; taxTotal: number }>;
  payments: Array<{
    method: string; amount: number; state: string; metadata: { tender?: { method?: string } } | null;
    refunds: Array<{ id: string; total: number; state: string; metadata: Record<string, string> | null }>;
  }>;
};
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };
type Filter = { registerId?: string; cashierId?: string };
type Line = { variantId: string; quantity: number; unitPriceMinor: number; discountMinor?: number; ratePpm?: number };

const HOUR = 3_600_000;

describe('GET /tally/v1/reports/sales/v2', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let base: string;
  let till: Record<string, string>;
  let reporter: Record<string, string>;
  // The fixture: three sales over two hours, two registers, two cashiers, cash, external and a split, a till discount,
  // two tax rates, and a partial refund made at another register by another cashier.
  const registerA = randomUUID();
  let registerB: string;
  const [cashier1, cashier2] = ['cashier-1', 'cashier-2'];
  let range: { from: string; to: string };
  let raw: RawOrder[];
  // The refund's own instant as the till sent it; Admin API createdAt is the Postgres wall time read as Node's local time.
  const refundAt = new Map<string, string>();

  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }, { id: variantIds.beans[0], stockOnHand: 1000 }] });
    // Mug is Standard (25%) and beans Reduced; Reduced becomes 10% so the fixture has two rates.
    const { taxRates } = await adminClient.query<{ taxRates: { items: Array<{ id: string; zone: { name: string }; category: { name: string } }> } }>(
      parse('query { taxRates { items { id zone { name } category { name } } } }'));
    const reduced = taxRates.items.find(rate => rate.zone.name === 'Denmark' && rate.category.name === 'Reduced')!;
    await adminClient.query(parse('mutation Rate($id: ID!) { updateTaxRate(input: { id: $id, value: 10 }) { id } }'), { id: reduced.id });
    base = await server.app.getUrl();
    till = await tokenWith(['TallyPosSell', 'TallyPosRefund']);
    reporter = await tokenWith(['TallyPosSell', 'ReadOrder']);

    const now = Date.now();
    range = { from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now + HOUR).toISOString() };
    const mug = (quantity: number, discountMinor?: number): Line => ({ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800,
      ...(discountMinor ? { discountMinor } : {}) });
    const beans = (quantity: number): Line => ({ variantId: variantIds.beans[0], quantity, unitPriceMinor: 500, ratePpm: 100_000 });
    const session = await openSession();
    registerB = session.registerId;
    const o1 = await sell(new Date(now - 2 * HOUR).toISOString(), registerA, cashier1, [mug(2), beans(1)], 'cash');
    await sell(new Date(now - 2 * HOUR + 60_000).toISOString(), registerA, cashier2, [mug(1, 100)], 'split');
    await sell(new Date(now - HOUR).toISOString(), registerB, cashier1, [beans(3)], 'external');
    const first = await readOrder(o1);
    const mugLine = first.lines.find(line => line.productVariant.id === variantIds.mug[0])!;
    await awayFromHourEdge();
    const refund = refundFor(first, session, { cashierRef: cashier2, lines: [{ orderLineId: mugLine.id, quantity: 1, restock: true }] });
    expect(await post(refund)).toMatchObject({ status: 'applied' });
    raw = await Promise.all((await adminClient.query<{ orders: { items: Array<{ id: string }> } }>(
      parse('query { orders(options: { take: 100 }) { items { id } } }'))).orders.items.map(order => readOrder(order.id)));
    for (const payment of raw.flatMap(order => order.payments)) {
      for (const item of payment.refunds) refundAt.set(item.id, refund.payload.createdAt);
    }
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
  async function openSession() {
    const session = { registerId: randomUUID(), sessionId: randomUUID() };
    expect(await post({ id: randomUUID(), type: 'register.session.open', version: 1, createdAt: new Date().toISOString(),
      deviceId: 'report-till', attempt: 1, payload: { ...session, openedAt: new Date().toISOString(), countedFloatMinor: 0 } }))
      .toMatchObject({ status: 'applied' });
    return session;
  }
  async function sell(at: string, registerId: string, cashierRef: string, lines: Line[], method: 'cash' | 'external' | 'split') {
    // orderCommand types version as 2 | 3; a v4 payload has the same shape, and its discountMinor is tax-exclusive.
    const command = orderCommand(lines, undefined, undefined, { version: 4 as never });
    Object.assign(command, { createdAt: at });
    Object.assign(command.payload, { createdAt: at, registerId, cashierRef });
    const total = command.payload.totalMinor;
    command.payload.payments = method === 'split'
      ? [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 500 },
        { clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', amountMinor: total - 500 }]
      : [{ clientPaymentId: randomUUID(), method, amountMinor: total, ...(method === 'external' ? { reference: 'card-2' } : {}) }];
    const result = await post(command);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    return result.serverRefs!.orderId;
  }
  async function readOrder(id: string): Promise<RawOrder> {
    const { order } = await adminClient.query<{ order: RawOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      id subTotal subTotalWithTax shipping shippingWithTax
      customFields { tallySaleAt tallyRegisterId tallyCashierRef }
      lines { id quantity proratedLinePriceWithTax productVariant { id sku name } }
      surcharges { sku price }
      taxSummary { description taxRate taxBase taxTotal }
      payments { method amount state metadata refunds { id total state metadata } }
    } }`), { id });
    return order;
  }
  function refundFor(order: RawOrder, session: { registerId: string; sessionId: string }, overrides: Partial<OrderRefundPayload>): RefundCommand {
    const createdAt = new Date().toISOString();
    const payload = {
      clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt, lines: [],
      shippingMinor: 0, adjustmentMinor: 0, destination: 'original_method' as const, reason: 'Returned at till', ...overrides,
    };
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'report-till', attempt: 1,
      payload: { ...payload, totalMinor: payload.lines.reduce((sum, line) => {
        const item = order.lines.find(item => item.id === line.orderLineId)!;
        return sum + Math.round(line.quantity * item.proratedLinePriceWithTax / item.quantity);
      }, 0) } };
  }
  // Hours in Asia/Kolkata start on the UTC half hour; a refund made in the last 10 s of one could land in the next.
  async function awayFromHourEdge() {
    const left = HOUR / 2 - (Date.now() % (HOUR / 2));
    if (left < 10_000) await new Promise(resolve => setTimeout(resolve, left + 1_000));
  }
  async function report(path: string, params: Record<string, string>, token: Record<string, string> = reporter) {
    const response = await fetch(`${base}/tally/v1/${path}?${new URLSearchParams(params)}`, { headers: token });
    return { status: response.status, body: await response.json() };
  }
  async function v2(params: Record<string, string>): Promise<TallySalesReportV2> {
    const { status, body } = await report('reports/sales/v2', params);
    expect(status, JSON.stringify(body)).toBe(200);
    return body;
  }

  const keyIn = (timeZone: string, iso: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso));
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}`;
  };
  const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const inRange = (iso: string) => Date.parse(iso) >= Date.parse(range.from) && Date.parse(iso) < Date.parse(range.to);
  const slot = <T>(map: Map<string, T>, key: string, make: () => T) => map.get(key) ?? map.set(key, make()).get(key)!;

  /** The whole report, worked out in TypeScript from the Admin API's reads of the orders, payments and refunds. */
  function derive(filter: Filter, timezone = 'UTC'): TallySalesReportV2 {
    const orders = raw.filter(order => inRange(order.customFields.tallySaleAt)
      && (filter.registerId === undefined || order.customFields.tallyRegisterId === filter.registerId)
      && (filter.cashierId === undefined || order.customFields.tallyCashierRef === filter.cashierId));
    // A till refund counts at its own register and cashier (its metadata), else at its sale's.
    const refunds = raw.flatMap(order => order.payments.flatMap(payment => payment.refunds.map(refund => ({ order, payment, refund }))))
      .filter(({ order, refund }) => refund.state !== 'Failed' && inRange(refundAt.get(refund.id)!)
        && (filter.registerId === undefined || (refund.metadata?.tallyRegisterId ?? order.customFields.tallyRegisterId) === filter.registerId)
        && (filter.cashierId === undefined || (refund.metadata?.tallyCashierRef ?? order.customFields.tallyCashierRef) === filter.cashierId));
    const hours = new Map<string, TallySalesReportV2['byHour'][number]>();
    const hour = (iso: string) => { const key = keyIn(timezone, iso); return slot(hours, key, () => ({ hour: key, orderCount: 0, salesMinor: 0, refundsMinor: 0 })); };
    const days = new Map<string, TallySalesReportV2['byDay'][number]>();
    const day = (iso: string) => { const key = keyIn(timezone, iso).slice(0, 10); return slot(days, key, () => ({ day: key, orderCount: 0, salesMinor: 0, refundsMinor: 0 })); };
    const methods = new Map<string, TallySalesReportV2['byMethod'][number] & { orders: Set<string> }>();
    const method = (key: string) => slot(methods, key, () => ({ method: key, salesMinor: 0, refundsMinor: 0, orderCount: 0, refundCount: 0, orders: new Set<string>() }));
    const products = new Map<string, TallySalesReportV2['products'][number]>();
    const taxes = new Map<string, TallySalesReportV2['taxes'][number]>();
    const totals = { count: 0, salesMinor: 0, taxMinor: 0, discountsMinor: 0, itemCount: 0 };
    for (const order of orders) {
      const sales = order.subTotalWithTax + order.shippingWithTax;
      for (const entry of [hour(order.customFields.tallySaleAt), day(order.customFields.tallySaleAt)]) {
        entry.orderCount += 1;
        entry.salesMinor += sales;
      }
      totals.count += 1;
      totals.salesMinor += sales;
      totals.taxMinor += order.subTotalWithTax - order.subTotal + order.shippingWithTax - order.shipping;
      // A v4 till discount is net, so the surcharge's price is its list price.
      totals.discountsMinor += order.surcharges.filter(item => item.sku === 'TALLY-DISCOUNT').reduce((sum, item) => sum - item.price, 0);
      for (const payment of order.payments.filter(item => item.state === 'Settled')) {
        const entry = method(payment.metadata?.tender?.method ?? payment.method);
        entry.salesMinor += payment.amount;
        entry.orders.add(order.id);
      }
      for (const line of order.lines) {
        totals.itemCount += line.quantity;
        const { id, sku, name } = line.productVariant;
        const entry = slot(products, id, () => ({ productVariantId: id, sku, name, quantity: 0, salesMinor: 0 }));
        entry.quantity += line.quantity;
        entry.salesMinor += line.proratedLinePriceWithTax;
      }
      for (const row of order.taxSummary) {
        const entry = slot(taxes, `${row.description}|${row.taxRate}`,
          () => ({ description: row.description, ratePercent: row.taxRate, baseMinor: 0, taxMinor: 0 }));
        entry.baseMinor += row.taxBase;
        entry.taxMinor += row.taxTotal;
      }
    }
    for (const { payment, refund } of refunds) {
      hour(refundAt.get(refund.id)!).refundsMinor += refund.total;
      day(refundAt.get(refund.id)!).refundsMinor += refund.total;
      const entry = method(refund.metadata?.tallyMethod ?? payment.metadata?.tender?.method ?? payment.method);
      entry.refundsMinor += refund.total;
      entry.refundCount += 1;
    }
    const sorted = [...products.values()].sort((a, b) => b.salesMinor - a.salesMinor || ascending(a.sku, b.sku));
    return {
      version: 2, ...range, timezone, currencyCode: 'EUR', registerId: filter.registerId ?? null, cashierId: filter.cashierId ?? null,
      orders: totals,
      refunds: { count: refunds.length, totalMinor: refunds.reduce((sum, item) => sum + item.refund.total, 0),
        orderCount: new Set(refunds.map(item => item.order.id)).size },
      byMethod: [...methods.values()].map(({ orders, ...row }) => ({ ...row, orderCount: orders.size }))
        .sort((a, b) => ascending(a.method, b.method)),
      byDay: [...days.values()].sort((a, b) => ascending(a.day, b.day)),
      byHour: [...hours.values()].sort((a, b) => ascending(a.hour, b.hour)),
      products: sorted.slice(0, 100), productsTruncated: sorted.length > 100,
      taxes: [...taxes.values()].sort((a, b) => a.ratePercent - b.ratePercent || ascending(a.description, b.description)),
    };
  }

  it('reads back the fixture it was built from', () => {
    expect(raw).toHaveLength(3);
    const store = derive({});
    expect(store.byHour.length).toBeGreaterThanOrEqual(2);
    expect(store.byMethod.map(row => row.method)).toEqual(['cash', 'external']);
    // The two line rates, beside the 0% row of the zero-priced till shipping line.
    expect(store.taxes.map(row => row.ratePercent)).toEqual(expect.arrayContaining([10, 25]));
    expect(store.orders.discountsMinor).toBeGreaterThan(0);
    expect(store.refunds.count).toBe(1);
    // The refund's own register and cashier differ from its sale's, so the filters can tell the two rules apart.
    expect(derive({ registerId: registerB }).refunds.count).toBe(1);
    expect(derive({ cashierId: cashier2 }).refunds.count).toBe(1);
    expect(derive({ registerId: registerA }).refunds.count).toBe(0);
    expect(derive({ cashierId: cashier1 }).refunds.count).toBe(0);
  });

  it('re-derives every figure from the raw orders, for the store, each register and each cashier', async () => {
    const queries: Array<[Filter, string]> = [
      [{}, 'UTC'], [{}, 'Asia/Kolkata'], [{ registerId: registerA }, 'UTC'], [{ registerId: registerB }, 'UTC'],
      [{ cashierId: cashier1 }, 'UTC'], [{ cashierId: cashier2 }, 'Asia/Kolkata'], [{ registerId: registerA, cashierId: cashier2 }, 'UTC'],
    ];
    for (const [filter, timezone] of queries) {
      const body = await v2({ ...range, timezone, ...filter });
      expect(body, JSON.stringify({ filter, timezone })).toEqual(derive(filter, timezone));
      expect(body.productsTruncated).toBe(false);
    }
  });

  it('agrees with v1 on every field they share', async () => {
    for (const filter of [{}, { registerId: registerA }, { registerId: registerB }] as Array<Record<string, string>>) {
      const params: Record<string, string> = { ...range, timezone: 'Asia/Kolkata', ...filter };
      const one = await report('reports/sales', params);
      expect(one.status).toBe(200);
      const { orders: { itemCount, ...orders }, refunds: { orderCount, ...refunds }, byMethod, byDay, from, to, timezone, currencyCode, registerId } = await v2(params);
      expect({ version: 1, from, to, timezone, currencyCode, registerId, orders, refunds, byDay,
        byMethod: byMethod.map(row => ({ method: row.method, salesMinor: row.salesMinor, refundsMinor: row.refundsMinor })),
      } satisfies TallySalesReport).toEqual(one.body);
    }
  });

  it('needs TallyPosSell and ReadOrder', async () => {
    expect((await report('reports/sales/v2', range, {})).status).toBe(403);
    expect(await report('reports/sales/v2', range, await tokenWith(['TallyPosSell']))).toEqual({ status: 403,
      body: { code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' } });
    expect((await report('reports/sales/v2', range)).status).toBe(200);
  });

  it('answers 400 invalid_query for a bad cashierId, after v1\'s checks', async () => {
    for (const cashierId of ['', 'c'.repeat(65)]) {
      expect(await report('reports/sales/v2', { ...range, cashierId })).toEqual({ status: 400,
        body: { code: 'invalid_query', message: 'cashierId must be 1 to 64 characters' } });
    }
    expect(await report('reports/sales/v2', { to: range.to, cashierId: '' })).toEqual({ status: 400,
      body: { code: 'invalid_query', message: 'from must be an ISO date-time with an offset' } });
    expect((await v2({ ...range, cashierId: 'c'.repeat(64) })).orders.count).toBe(0);
  });
});
