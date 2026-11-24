import { randomUUID } from 'node:crypto';
import { TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult, OrderRefundEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type Sale = { id: string; lines: Array<{ id: string; quantity: number; proratedLinePriceWithTax: number }> };
type Channel = { id: string; token: string; pricesIncludeTax: boolean; headers: Record<string, string>; orders: string[] };
type RefundCommand = Omit<OrderRefundEnvelope, 'version'> & { version: number };

describe('sales report oracle fixture (#481)', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode } = environment;
  const range = { from: '2026-03-01T00:00:00Z', to: '2026-03-03T00:00:00Z' };
  const timezone = 'Australia/Sydney';
  const writerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = ['2026-03-01T12:59:00Z', '2026-03-01T13:01:00Z'];
  const adjustment = [{ adjustmentSource: 'PROMOTION:1', type: 'PROMOTION', description: 'fixture', amount: -150 }];
  const splitTax = [{ description: 'Split A', taxRate: 15 }, { description: 'Split B', taxRate: 10 }];
  const plain: Sale[] = [], discounted: Sale[] = [], charged: Sale[] = [], midnight: Sale[] = [];
  let base: string, saleAt: string, zeroId: string, quantityRoute: string;
  let db: TransactionalConnection['rawConnection'];
  let channels: Channel[];
  let full: Sale, partial: Sale, cancelled: Sale, changedQuantity: Sale, adjusted: Sale, split: Sale, deleted: Sale;

  beforeAll(async () => {
    await environment.init();
    db = server.app.get(TransactionalConnection).rawConnection;
    base = await server.app.getUrl();
    const { activeChannel, zones } = await adminClient.query<{
      activeChannel: Omit<Channel, 'headers' | 'orders'>; zones: { items: Array<{ id: string; name: string }> };
    }>(parse('query { activeChannel { id token pricesIncludeTax } zones { items { id name } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: Omit<Channel, 'headers' | 'orders'> }>(parse(`mutation Channel($input: CreateChannelInput!) {
      createChannel(input: $input) { ... on Channel { id token pricesIncludeTax } ... on ErrorResult { message } }
    }`), { input: { code: 'oracle-second', token: 'oracle-second-token', pricesIncludeTax: !activeChannel.pricesIncludeTax,
      defaultLanguageCode: 'en', defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'],
      defaultTaxZoneId: denmark, defaultShippingZoneId: denmark } });
    expect(createChannel.id).toBeTruthy();
    await adminClient.query(parse(`mutation Assign($input: AssignProductVariantsToChannelInput!) {
      assignProductVariantsToChannel(input: $input) { id }
    }`), { input: { productVariantIds: [variantIds.mug[0], variantIds.beans[0]], channelId: createChannel.id } });
    // As in channels.e2e.ts, the second channel has no stock location of its own.
    await adminClient.query(parse(`mutation Untrack($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [variantIds.mug[0], variantIds.beans[0]].map(id => ({ id, trackInventory: 'FALSE' })) });
    channels = [];
    for (const channel of [activeChannel, createChannel]) {
      adminClient.setChannelToken(channel.token);
      const headers = { ...await tokenWith(['TallyPosSell', 'TallyPosRefund', 'ReadOrder']), 'vendure-token': channel.token };
      channels.push({ ...channel, headers, orders: [] });
    }
    adminClient.setChannelToken(activeChannel.token);
    const mug = (quantity: number) => ({ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800 });
    for (const channel of channels) {
      plain.push(await sell([mug(2), { variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500 }], channel));
      discounted.push(await sell([{ ...mug(1), discountMinor: 100 }], channel, '2026-03-01T14:00:00Z'));
      charged.push(await sell([mug(1)], channel, '2026-03-02T10:00:00Z', true));
    }
    full = await sell([mug(2)]);
    partial = await sell([mug(3)]);
    const createdAt = '2026-03-02T11:00:00Z';
    const session = { registerId: randomUUID(), sessionId: randomUUID() };
    await post({ id: randomUUID(), type: 'register.session.open', version: 1, createdAt, deviceId: 'report-till', attempt: 1,
      payload: { ...session, openedAt: createdAt, countedFloatMinor: 0 } });
    for (const [order, quantity] of [[full, 2], [partial, 1]] as const) {
      const line = order.lines[0];
      const refund: RefundCommand = { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'report-till', attempt: 1,
        payload: { clientRefundId: randomUUID(), orderId: order.id, ...session, cashierRef: 'refund-cashier', createdAt,
          lines: [{ orderLineId: line.id, quantity, restock: true }], shippingMinor: 0, adjustmentMinor: 0,
          destination: 'original_method', reason: 'Oracle fixture',
          totalMinor: Math.round(quantity * line.proratedLinePriceWithTax / line.quantity) } };
      await post(refund);
    }
    cancelled = await sell([mug(1)]);
    expect(await cancel(cancelled, 1)).toMatchObject({ id: cancelled.id, state: 'Cancelled' });
    changedQuantity = await sell([mug(3)]);
    const cancellation = await cancel(changedQuantity, 1);
    if (cancellation.errorCode) {
      expect(['CANCEL_ACTIVE_ORDER_ERROR', 'ORDER_STATE_TRANSITION_ERROR']).toContain(cancellation.errorCode);
      await db.query('UPDATE "order_line" SET "quantity" = "quantity" - 1 WHERE "id" = $1', [decode(changedQuantity.lines[0].id)]);
      quantityRoute = 'SQL UPDATE after Admin cancelOrder refused the state';
    } else {
      expect(cancellation.id).toBe(changedQuantity.id);
      quantityRoute = 'Admin cancelOrder';
    }
    console.log(`Case 8 route: ${quantityRoute}`);
    adjusted = await sell([mug(1)]);
    await db.query('UPDATE "order_line" SET "adjustments" = $1 WHERE "id" = $2', [JSON.stringify(adjustment), decode(adjusted.lines[0].id)]);
    await db.query('UPDATE "shipping_line" SET "adjustments" = $1 WHERE "orderId" = $2', [JSON.stringify(adjustment), decode(charged[0].id)]);
    split = await sell([mug(1)]);
    await db.query('UPDATE "order_line" SET "taxLines" = $1 WHERE "id" = $2', [JSON.stringify(splitTax), decode(split.lines[0].id)]);
    deleted = await sell([{ variantId: variantIds.print[0], quantity: 1, unitPriceMinor: 4500 }]);
    const deletion = await adminClient.query(parse('mutation Delete($id: ID!) { deleteProductVariant(id: $id) { result } }'), { id: variantIds.print[0] });
    expect(deletion.deleteProductVariant.result).toBe('DELETED');

    const columns: Record<string, string[]> = {};
    for (const table of ['order', 'order_channels_channel', 'payment']) {
      const rows: Array<{ column_name: string }> = await db.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]);
      columns[table] = rows.map(row => row.column_name);
    }
    const clientOrderId = columns.order.find(column => column.toLowerCase().endsWith('tallyclientorderid'))!;
    saleAt = columns.order.find(column => column.toLowerCase().endsWith('tallysaleat'))!;
    const copied = columns.order.filter(column => !['id', 'code', clientOrderId, saleAt].includes(column));
    const [clone] = await db.query(`INSERT INTO "order" (${copied.map(column => `"${column}"`).join(', ')},
      "code", "${clientOrderId}", "${saleAt}")
      SELECT ${copied.map(column => `"${column}"`).join(', ')}, $1, $2, $3::timestamptz AT TIME ZONE $4
      FROM "order" WHERE "id" = $5 RETURNING "id"`,
    [`oracle-${randomUUID()}`, randomUUID(), '2026-03-02T12:00:00Z', writerZone, decode(plain[0].id)]);
    zeroId = String(clone.id);
    channels[0].orders.push(zeroId);
    // Deliberately copy neither order_line nor surcharge rows.
    for (const table of ['order_channels_channel', 'payment']) {
      const child = columns[table].filter(column => !['id', 'orderId'].includes(column));
      await db.query(`INSERT INTO "${table}" (${child.map(column => `"${column}"`).join(', ')}, "orderId")
        SELECT ${child.map(column => `"${column}"`).join(', ')}, $1 FROM "${table}" WHERE "orderId" = $2`,
      [zeroId, decode(plain[0].id)]);
    }
    for (const at of boundary) midnight.push(await sell([mug(1)], channels[0], at));
  });
  afterAll(() => server.destroy());

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
  async function post(command: unknown, channel = channels[0]): Promise<CommandResult> {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...channel.headers },
      body: JSON.stringify({ commands: [command] }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()).results[0];
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    return result;
  }
  async function sell(lines: Parameters<typeof orderCommand>[0], channel = channels[0], at = '2026-03-01T10:00:00Z', charges = false) {
    const command = orderCommand(lines, undefined, undefined, { pricesIncludeTax: channel.pricesIncludeTax });
    command.createdAt = command.payload.createdAt = at;
    if (charges) {
      command.version = 5;
      const p = command.payload, inclusive = channel.pricesIncludeTax;
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
    const result = await post(command, channel);
    const { order } = await adminClient.query<{ order: Sale }>(parse(`query Order($id: ID!) {
      order(id: $id) { id lines { id quantity proratedLinePriceWithTax } }
    }`), { id: result.serverRefs!.orderId });
    channel.orders.push(decode(order.id));
    return order;
  }
  async function cancel(order: Sale, quantity: number) {
    const { cancelOrder } = await adminClient.query<{ cancelOrder: { id?: string; state?: string; errorCode?: string } }>(parse(`mutation Cancel($input: CancelOrderInput!) {
      cancelOrder(input: $input) { ... on Order { id state } ... on ErrorResult { errorCode message } }
    }`), { input: { orderId: order.id, lines: [{ orderLineId: order.lines[0].id, quantity }], reason: 'Oracle fixture' } });
    return cancelOrder;
  }
  async function report(path: string, params: Record<string, string>, token: Record<string, string>) {
    const response = await fetch(`${base}/tally/v1/${path}?${new URLSearchParams(params)}`, { headers: token });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  }

  it('stores two channels with opposite tax modes and matching line modes', async () => {
    const rows = await db.query('SELECT "pricesIncludeTax" FROM "channel" WHERE "id"::text = ANY($1::text[])', [channels.map(c => decode(c.id))]);
    expect(rows.map((row: { pricesIncludeTax: boolean }) => row.pricesIncludeTax).sort()).toEqual([false, true]);
    for (const channel of channels) {
      const lines = await db.query('SELECT "listPriceIncludesTax" FROM "order_line" WHERE "orderId"::text = ANY($1::text[])', [channel.orders]);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((row: { listPriceIncludesTax: boolean }) => row.listPriceIncludesTax === channel.pricesIncludeTax)).toBe(true);
    }
  });

  it('stores plain mug x2 and beans x1 sales without discounts on both channels', async () => {
    for (const order of plain) {
      const rows = await db.query('SELECT "productVariantId"::text, "quantity", "adjustments" FROM "order_line" WHERE "orderId" = $1', [decode(order.id)]);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        { productVariantId: decode(variantIds.mug[0]), quantity: 2, adjustments: '[]' },
        { productVariantId: decode(variantIds.beans[0]), quantity: 1, adjustments: '[]' },
      ]));
      expect(await db.query('SELECT "id" FROM "surcharge" WHERE "orderId" = $1', [decode(order.id)])).toHaveLength(0);
    }
  });

  it('stores till discounts as discount surcharges on both channels', async () => {
    for (const order of discounted) {
      const rows = await db.query('SELECT "listPrice" FROM "surcharge" WHERE "orderId" = $1 AND "sku" = $2', [decode(order.id), 'TALLY-DISCOUNT']);
      expect(rows).toEqual([{ listPrice: -100 }]);
    }
  });

  it('stores a cancelled order', async () => {
    expect(await db.query('SELECT "state" FROM "order" WHERE "id" = $1', [decode(cancelled.id)])).toEqual([{ state: 'Cancelled' }]);
  });

  it('stores a settled full refund and a settled one-unit part refund', async () => {
    for (const [order, quantity] of [[full, 2], [partial, 1]] as const) {
      const rows = await db.query(`SELECT r."state", r."total", p."amount" FROM "refund" r
        JOIN "payment" p ON p."id" = r."paymentId" WHERE p."orderId" = $1`, [decode(order.id)]);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('Settled');
      expect(await db.query('SELECT "orderPlacedQuantity" FROM "order_line" WHERE "id" = $1', [decode(order.lines[0].id)]))
        .toEqual([{ orderPlacedQuantity: order === full ? 2 : 3 }]);
      expect(rows[0].total).toBe(Math.round(quantity * order.lines[0].proratedLinePriceWithTax / order.lines[0].quantity));
      expect(rows[0].total).toBeGreaterThan(0);
      if (order === full) expect(rows[0].total).toBe(rows[0].amount);
      else expect(rows[0].total).toBeLessThan(rows[0].amount);
    }
  });

  it('stores taxable fees and shipping on both channels', async () => {
    for (const order of charged) {
      const fees = await db.query('SELECT "taxLines" FROM "surcharge" WHERE "orderId" = $1 AND "sku" = $2', [decode(order.id), 'TALLY-FEE']);
      const shipping = await db.query('SELECT "taxLines" FROM "shipping_line" WHERE "orderId" = $1', [decode(order.id)]);
      expect(fees).toHaveLength(1);
      expect(shipping).toHaveLength(1);
      for (const row of [...fees, ...shipping]) expect(JSON.parse(row.taxLines)).toEqual([expect.objectContaining({ taxRate: 25 })]);
    }
  });

  it('stores quantity different from orderPlacedQuantity', async () => {
    const rows = await db.query(`SELECT "quantity", "orderPlacedQuantity" FROM "order_line"
      WHERE "id" = $1 AND "quantity" <> "orderPlacedQuantity"`, [decode(changedQuantity.lines[0].id)]);
    expect(rows, quantityRoute).toEqual([{ quantity: 2, orderPlacedQuantity: 3 }]);
  });

  it('stores promotion adjustments on a line and the taxed shipping line', async () => {
    for (const [table, order] of [['order_line', adjusted], ['shipping_line', charged[0]]] as const) {
      const rows = await db.query(`SELECT "adjustments" FROM "${table}" WHERE "orderId" = $1`, [decode(order.id)]);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].adjustments)).toEqual(adjustment);
    }
  });

  it('stores two tax rates on one line', async () => {
    const rows = await db.query('SELECT "taxLines" FROM "order_line" WHERE "id" = $1', [decode(split.lines[0].id)]);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].taxLines)).toEqual(splitTax);
  });

  it('retains a line whose variant was soft deleted', async () => {
    const rows = await db.query(`SELECT v."deletedAt" FROM "order_line" l JOIN "product_variant" v ON v."id" = l."productVariantId"
      WHERE l."orderId" = $1 AND v."deletedAt" IS NOT NULL`, [decode(deleted.id)]);
    expect(rows).toHaveLength(1);
  });

  it('stores the zero-line clone in R with a payment and channel but no surcharge', async () => {
    const rows = await db.query(`SELECT o."id"::text FROM "order" o WHERE o."id" = $1
      AND (o."${saleAt}" AT TIME ZONE $2) >= $3::timestamptz AND (o."${saleAt}" AT TIME ZONE $2) < $4::timestamptz
      AND NOT EXISTS (SELECT 1 FROM "order_line" l WHERE l."orderId" = o."id")
      AND NOT EXISTS (SELECT 1 FROM "surcharge" s WHERE s."orderId" = o."id")
      AND EXISTS (SELECT 1 FROM "payment" p WHERE p."orderId" = o."id")
      AND EXISTS (SELECT 1 FROM "order_channels_channel" c WHERE c."orderId" = o."id" AND c."channelId" = $5)`,
    [zeroId, writerZone, range.from, range.to, decode(channels[0].id)]);
    expect(rows).toEqual([{ id: zeroId }]);
  });

  it('stores sales immediately either side of Sydney midnight', async () => {
    for (const [index, order] of midnight.entries()) {
      const rows = await db.query(`SELECT ("${saleAt}" AT TIME ZONE $1) AS instant FROM "order" WHERE "id" = $2`, [writerZone, decode(order.id)]);
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0].instant).toISOString()).toBe(new Date(boundary[index]).toISOString());
    }
  });

  it('answers 200 for v1, v2 and v3 on each channel with the seeded counts', async () => {
    for (const [index, channel] of channels.entries()) {
      // assignToCurrentChannel() also puts second-channel orders in the default channel.
      const count = index === 0 ? channels.reduce((sum, item) => sum + item.orders.length, 0) : channel.orders.length;
      for (const version of ['', '/v2', '/v3']) {
        const result = await report(`reports/sales${version}`, version ? { ...range, timezone } : range, channel.headers);
        expect(result.status, result.text).toBe(200);
        if (version === '/v2') {
          expect(result.body.orders.count).toBe(count);
          expect(result.body.byDay.length).toBeGreaterThan(1);
        }
      }
    }
  });

  it('returns byte-identical v2 and v3 bodies on repeated requests', async () => {
    for (const channel of channels) for (const version of ['v2', 'v3']) {
      const first = await report(`reports/sales/${version}`, { ...range, timezone }, channel.headers);
      const second = await report(`reports/sales/${version}`, { ...range, timezone }, channel.headers);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.text).toBe(first.text);
    }
  });
});
