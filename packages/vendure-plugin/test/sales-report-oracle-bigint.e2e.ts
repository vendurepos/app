import { randomUUID } from 'node:crypto';
import { BigIntMoneyStrategy, Order, RequestContextService, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReportService } from '../src/service/report.service';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('sales report raw-row oracle with BigIntMoneyStrategy (#481)', () => {
  const environment = createPluginTestEnvironment({ entityOptions: { moneyStrategy: new BigIntMoneyStrategy() } });
  const { server, adminClient, variantIds, decode, run } = environment;
  const range = { from: '2026-03-01T00:00:00Z', to: '2026-03-03T00:00:00Z' };
  const timezone = 'Australia/Sydney';
  let base: string, channelToken: string, bigId: string, chargedId: string, smallId: string;
  let headers: Record<string, string>;
  let db: TransactionalConnection['rawConnection'];

  beforeAll(async () => {
    await environment.init();
    db = server.app.get(TransactionalConnection).rawConnection;
    base = await server.app.getUrl();
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string; token: string } }>(
      parse('query { activeChannel { id token } }'));
    channelToken = activeChannel.token;
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `report-${randomUUID()}`, description: 'Sales report test',
      permissions: ['TallyPosSell', 'ReadOrder'], channelIds: [activeChannel.id] } });
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
    headers = { Authorization: `Bearer ${token}`, 'vendure-token': channelToken };

    bigId = await sell([{ variantId: variantIds.mug[0], quantity: 10, unitPriceMinor: 2_000_000_000, discountMinor: 3_000_000_000 }]);
    chargedId = await sell([{ variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500 }], true);
    smallId = await sell([{ variantId: variantIds.beans[1], quantity: 1, unitPriceMinor: 900 }]);
    // unitPriceMinor is an int4 custom field, so exercise a bigint line price after the sale.
    await db.query('UPDATE "order_line" SET "listPrice" = $1 WHERE "orderId" = $2', [3_000_000_000, smallId]);
  });
  afterAll(() => server.destroy());

  async function sell(lines: Parameters<typeof orderCommand>[0], charges = false) {
    const command = orderCommand(lines);
    command.createdAt = command.payload.createdAt = '2026-03-01T10:00:00Z';
    if (charges) {
      command.version = 5;
      const p = command.payload, inclusive = p.pricesIncludeTax;
      p.shipping = [{ clientShippingId: 'shipping-1', name: 'Delivery', amountMinor: inclusive ? 500 : 400,
        taxStatus: 'taxable', taxClass: 'Standard', taxMinor: 100 }];
      p.fees = [{ clientFeeId: 'fee-1', name: 'Handling', amountMinor: inclusive ? 125 : 100,
        taxStatus: 'taxable', taxClass: 'Standard', taxMinor: 25 }];
      p.subtotalMinor += 500;
      p.taxMinor += 125;
      p.totalMinor += 625;
      p.payments[0].amountMinor = p.totalMinor;
      p.display!.shipping = [{ clientShippingId: 'shipping-1', amountMinor: p.shipping[0].amountMinor }];
      p.display!.fees = [{ clientFeeId: 'fee-1', amountMinor: p.fees[0].amountMinor }];
      p.display!.taxMinor = p.taxMinor;
      p.display!.totalMinor = p.totalMinor;
      p.taxByRate![0].netMinor += 500;
      p.taxByRate![0].taxMinor += 125;
      p.taxByRate![0].grossMinor += 625;
    }
    const result = await run(command);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    return decode(result.serverRefs!.orderId);
  }

  async function runMode(mode: 'find' | 'raw') {
    const service = server.app.get(ReportService) as any;
    const realFind = service.ordersFind.bind(service), realLines = service.linesAndTaxes.bind(service);
    const rawPage = service.rawPage;
    const spies: Array<{ mockRestore(): void }> = [];
    const bodies: string[] = [], lines: unknown[][] = [];
    let captured: unknown[] = [];
    try {
      const findSpy = vi.spyOn(service, 'ordersFind');
      spies.push(findSpy);
      const rawSpy = vi.spyOn(service, 'ordersRaw');
      spies.push(rawSpy);
      if (mode === 'find') rawSpy.mockImplementation((...args) => realFind(...args));
      const linesSpy = vi.spyOn(service, 'linesAndTaxes').mockImplementation(async (...args) => {
        const result = await realLines(...args);
        captured.push({ ...result, orderTotals: [...result.orderTotals].sort((a, b) => a - b) });
        return result;
      });
      spies.push(linesSpy);
      for (const version of ['', '/v2', '/v3']) {
        captured = [];
        const params = new URLSearchParams(version ? { ...range, timezone } : range);
        const response = await fetch(`${base}/tally/v1/reports/sales${version}?${params}`, { headers });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        expect(JSON.parse(text).orders.count).toBe(3);
        bodies.push(text);
        expect(captured).toHaveLength(version ? 1 : 0);
        lines.push(captured);
      }
      expect(rawSpy).toHaveBeenCalled();
      if (mode === 'raw') expect(findSpy).not.toHaveBeenCalled();
      return { bodies, lines };
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      service.rawPage = rawPage;
    }
  }

  it('stores the surcharge, line and order values beyond int4 and taxable charges', async () => {
    const surcharges = await db.query('SELECT "listPrice" FROM "surcharge" WHERE "orderId" = $1', [bigId]);
    const lines = await db.query('SELECT "listPrice" FROM "order_line" WHERE "orderId" = $1', [smallId]);
    const orders = await db.query('SELECT "subTotalWithTax" FROM "order" WHERE "id" = $1', [bigId]);
    for (const rows of [surcharges, lines, orders]) expect(rows).toHaveLength(1);
    expect(BigInt(surcharges[0].listPrice)).toBeLessThan(-2_147_483_648n);
    expect(BigInt(lines[0].listPrice)).toBeGreaterThan(2_147_483_647n);
    expect(BigInt(orders[0].subTotalWithTax)).toBeGreaterThan(2_147_483_647n);
    for (const table of ['surcharge', 'shipping_line']) {
      const rows = await db.query(`SELECT "taxLines" FROM "${table}" WHERE "orderId" = $1`, [chargedId]);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].taxLines)).toEqual([expect.objectContaining({ taxRate: 25 })]);
    }
  });

  it('returns byte-identical bodies and identical lines and taxes for find and raw', async () => {
    const oracle = await runMode('find'), raw = await runMode('raw');
    expect(raw.bodies).toHaveLength(oracle.bodies.length);
    raw.bodies.forEach((body, index) => expect(body).toBe(oracle.bodies[index]));
    expect(raw.lines).toEqual(oracle.lines);
  });

  it('hydrates all three above-int4 values as the same numbers as find', async () => {
    const service = server.app.get(ReportService) as any;
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', channelOrToken: channelToken });
    const ids = [bigId, chargedId, smallId];
    const found: Order[] = await service.ordersFind(ctx, ids), raw: Order[] = await service.ordersRaw(ctx, ids);
    const values = (orders: Order[]) => [
      orders.find(order => String(order.id) === bigId)!.surcharges[0].listPrice,
      orders.find(order => String(order.id) === smallId)!.lines[0].listPrice,
      orders.find(order => String(order.id) === bigId)!.subTotalWithTax,
    ];
    const expected = values(found), actual = values(raw);
    for (const [index, value] of actual.entries()) {
      expect(value).toBe(expected[index]);
      expect(typeof value).toBe('number');
      expect(typeof expected[index]).toBe('number');
    }
  });
});
