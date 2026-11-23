import { randomUUID } from 'node:crypto';
import { TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from '../env';
import { orderCommand } from '../payloads';

const DAYS = 366; // A full leap year's trading days.
const ORDERS_PER_DAY = 1000; // Busy-store daily sales volume.
const DISCOUNTED_SHARE = 0.3; // Fraction of clones with two line discounts.
const RUNS = 5; // Timed requests per route, after one warm-up.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('sales report discount performance', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let base: string;
  let token: Record<string, string>;

  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [variantIds.mug[0], variantIds.beans[0]].map(id => ({ id, stockOnHand: 1_000_000 })) });
    base = await server.app.getUrl();
    token = await tokenWith(['TallyPosSell', 'ReadOrder']);
  });
  afterAll(() => server.destroy());

  async function tokenWith(permissions: string[]) {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `perf-${randomUUID()}`, description: 'Sales report perf', permissions, channelIds: [activeChannel.id] } });
    const emailAddress = `${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: 'Report', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const response = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") {
        ... on CurrentUser { id } ... on ErrorResult { errorCode } } }` }),
    });
    expect((await response.json()).data.login).toMatchObject({ id: expect.any(String) });
    const authToken = response.headers.get('vendure-auth-token');
    expect(authToken).toBeTruthy();
    return { Authorization: `Bearer ${authToken}` };
  }
  async function post(command: unknown) {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...token },
      body: JSON.stringify({ commands: [command] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).results[0];
  }
  async function report(path: string, query: Record<string, string>, token: Record<string, string>) {
    const response = await fetch(`${base}${path}?${new URLSearchParams(query)}`, { headers: token });
    return { status: response.status, body: await response.json() };
  }

  it('prints year-range timings for v1, v2 and v3', async () => {
    const seedingStarted = performance.now();
    const discounted = orderCommand([
      { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, discountMinor: 100 },
      { variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500, discountMinor: 50 },
    ]);
    const plain = orderCommand([
      { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 },
      { variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500 },
    ]);
    expect(await post(discounted)).toMatchObject({ status: 'applied' });
    expect(await post(plain)).toMatchObject({ status: 'applied' });
    const seedAt = Date.parse(discounted.payload.createdAt);
    const firstSaleAt = seedAt - HOUR - (DAYS - 1) * DAY;
    const firstDay = new Date(firstSaleAt);
    firstDay.setUTCHours(0, 0, 0, 0);
    const range = { from: firstDay.toISOString(), to: new Date(seedAt + HOUR).toISOString() };
    const seedReport = await report('/tally/v1/reports/sales/v2', {
      from: new Date(seedAt).toISOString(), to: range.to,
    }, token);
    expect(seedReport.status).toBe(200);
    expect(seedReport.body.orders.count).toBe(2);
    const seedDiscount = seedReport.body.orders.discountsMinor;
    const total = DAYS * ORDERS_PER_DAY;
    const discountedClones = Math.round(total * DISCOUNTED_SHARE);
    const connection = server.app.get(TransactionalConnection).rawConnection;
    const tables = ['order', 'order_channels_channel', 'order_line', 'surcharge', 'payment'];
    const columns: Record<string, string[]> = {};
    for (const table of tables) {
      const rows: Array<{ column_name: string }> = await connection.query(`SELECT column_name
        FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1
        ORDER BY ordinal_position`, [table]);
      columns[table] = rows.map(row => row.column_name);
    }
    const clientOrderId = columns.order.find(column => column.toLowerCase().endsWith('tallyclientorderid'))!;
    const saleAt = columns.order.find(column => column.toLowerCase().endsWith('tallysaleat'))!;
    const orderColumns = columns.order.filter(column => !['id', 'code', clientOrderId, saleAt].includes(column));
    const writerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [seed, start, end] of [[discounted, 1, discountedClones], [plain, discountedClones + 1, total]] as const) {
      for (let first = start; first <= end; first += 50_000) {
        const last = Math.min(first + 49_999, end);
        const params = [first, last, seed.payload.clientOrderId];
        // Integer division places exactly ORDERS_PER_DAY clones on each day, ending one hour before the seeds.
        await connection.query(`INSERT INTO "order" (${orderColumns.map(column => `"${column}"`).join(', ')},
          "code", "${clientOrderId}", "${saleAt}")
          SELECT ${orderColumns.map(column => `seed."${column}"`).join(', ')},
            seed."code" || '-perf-' || clones.n, gen_random_uuid()::text,
            ($4::timestamptz + ((clones.n - 1) / $5::int) * interval '24 hours') AT TIME ZONE $6
          FROM "order" seed CROSS JOIN generate_series($1::int, $2::int) clones(n)
          WHERE seed."${clientOrderId}" = $3`, [...params, new Date(firstSaleAt).toISOString(), ORDERS_PER_DAY, writerZone]);
        for (const table of tables.slice(1)) {
          const copied = columns[table].filter(column => column !== 'id' && column !== 'orderId');
          await connection.query(`INSERT INTO "${table}" (${copied.map(column => `"${column}"`).join(', ')}, "orderId")
            SELECT ${copied.map(column => `child."${column}"`).join(', ')}, clone."id"
            FROM "order" seed CROSS JOIN generate_series($1::int, $2::int) clones(n)
            JOIN "order" clone ON clone."code" = seed."code" || '-perf-' || clones.n
            JOIN "${table}" child ON child."orderId" = seed."id"
            WHERE seed."${clientOrderId}" = $3`, params);
        }
      }
    }
    for (const table of tables) await connection.query(`ANALYZE "${table}"`);
    console.log(`Seeding time: ${performance.now() - seedingStarted} ms`);
    const [{ count }] = await connection.query(`SELECT count(*) AS count FROM "surcharge" s
      JOIN "order" o ON o."id" = s."orderId" WHERE s."sku" = 'TALLY-DISCOUNT'
      AND (o."${saleAt}" AT TIME ZONE $1) >= $2::timestamptz
      AND (o."${saleAt}" AT TIME ZONE $1) < $3::timestamptz`, [writerZone, range.from, range.to]);
    const discountSurcharges = Number(count);
    for (const route of ['/tally/v1/reports/sales', '/tally/v1/reports/sales/v2', '/tally/v1/reports/sales/v3']) {
      const timings: number[] = [];
      for (let run = 0; run <= RUNS; run++) {
        const started = performance.now();
        const { status, body } = await report(route, range, token);
        const elapsed = performance.now() - started;
        expect(status).toBe(200);
        expect(body.orders.count).toBe(total + 2);
        expect(body.orders.discountsMinor).toBe((discountedClones + 1) * seedDiscount);
        if (run > 0) timings.push(elapsed);
      }
      timings.sort((a, b) => a - b);
      const medianMs = timings[Math.floor(RUNS / 2)];
      const maxMs = timings[RUNS - 1];
      console.log('PERF ' + JSON.stringify({ route, medianMs, maxMs, runs: RUNS, orders: total + 2, discountSurcharges }));
    }
  });
});
