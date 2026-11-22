import { randomUUID } from 'node:crypto';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TallySalesReportV3 } from '../src/service/report.service';
import type { CommandResult } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// An order as Vendure's Admin API reads it back: every expected figure is derived from these.
type RawOrder = {
  id: string; subTotalWithTax: number; shippingWithTax: number;
  customFields: { tallyRegisterId: string; tallyCashierRef: string };
  lines: Array<{ quantity: number; proratedLinePriceWithTax: number; productVariant: { id: string } }>;
};
type Filter = { registerId?: string; cashierId?: string };
type Line = { variantId: string; quantity: number; unitPriceMinor: number; discountMinor?: number; ratePpm?: number };

const HOUR = 3_600_000;

describe('GET /tally/v1/reports/sales/v3', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let base: string;
  let till: Record<string, string>;
  let reporter: Record<string, string>;
  // The fixture: four sales over two registers and two cashiers. Mug is in Kitchen and in Gifts (a private collection),
  // the 500 beans only in Kitchen, the 900 beans in no collection. One mug carries a till discount.
  const [registerA, registerB] = [randomUUID(), randomUUID()];
  const [cashier1, cashier2] = ['cashier-1', 'cashier-2'];
  let range: { from: string; to: string };
  let raw: RawOrder[];
  const collections: Record<'kitchen' | 'gifts', string> = { kitchen: '', gifts: '' };
  let membership: Map<string, string[]>;

  beforeAll(async () => {
    await environment.init();
    const { taxRates } = await adminClient.query<{ taxRates: { items: Array<{ id: string; zone: { name: string }; category: { name: string } }> } }>(
      parse('query { taxRates { items { id zone { name } category { name } } } }'));
    const reduced = taxRates.items.find(rate => rate.zone.name === 'Denmark' && rate.category.name === 'Reduced')!;
    await adminClient.query(parse('mutation Rate($id: ID!) { updateTaxRate(input: { id: $id, value: 10 }) { id } }'), { id: reduced.id });
    collections.kitchen = await collection('Kitchen', [variantIds.mug[0], variantIds.beans[0]], false);
    collections.gifts = await collection('Gifts', [variantIds.mug[0]], true);
    membership = new Map([[variantIds.mug[0], [collections.kitchen, collections.gifts]], [variantIds.beans[0], [collections.kitchen]]]);
    base = await server.app.getUrl();
    till = await tokenWith(['TallyPosSell']);
    reporter = await tokenWith(['TallyPosSell', 'ReadOrder']);

    const now = Date.now();
    range = { from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now + HOUR).toISOString() };
    const mug = (discountMinor?: number): Line => ({ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800,
      ...(discountMinor ? { discountMinor } : {}) });
    const beans = (index: 0 | 1): Line => ({ variantId: variantIds.beans[index], quantity: 1, unitPriceMinor: [500, 900][index], ratePpm: 100_000 });
    const ids = [
      await sell(new Date(now - 2 * HOUR).toISOString(), registerA, cashier1, [mug()]),
      await sell(new Date(now - 2 * HOUR + 60_000).toISOString(), registerA, cashier1, [beans(0)]),
      await sell(new Date(now - HOUR).toISOString(), registerA, cashier2, [mug(100)]),
      await sell(new Date(now - HOUR + 60_000).toISOString(), registerB, cashier2, [beans(0), beans(1)]),
    ];
    raw = await Promise.all(ids.map(readOrder));
  });
  afterAll(() => server.destroy());

  /** A collection of exactly these variants; Vendure applies its filter on the job queue, so wait until it has. */
  async function collection(name: string, ids: string[], isPrivate: boolean) {
    const { createCollection } = await adminClient.query<{ createCollection: { id: string } }>(parse(`mutation C($input: CreateCollectionInput!) {
      createCollection(input: $input) { id }
    }`), { input: { isPrivate, translations: [{ languageCode: 'en', name, slug: name.toLowerCase(), description: '' }],
      filters: [{ code: 'variant-id-filter', arguments: [{ name: 'variantIds', value: JSON.stringify(ids) }, { name: 'combineWithAnd', value: 'true' }] }] } });
    for (let attempt = 0; attempt < 100; attempt++) {
      const { collection } = await adminClient.query<{ collection: { productVariants: { items: Array<{ id: string }> } } }>(parse(`query V($id: ID!) {
        collection(id: $id) { productVariants { items { id } } }
      }`), { id: createCollection.id });
      if (collection.productVariants.items.length === ids.length) return createCollection.id;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${name} never received its variants`);
  }
  const headers = (token: Record<string, string>) => ({ 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...token });
  async function post(command: unknown): Promise<CommandResult> {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: headers(till), body: JSON.stringify({ commands: [command] }),
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
    return { Authorization: `Bearer ${response.headers.get('vendure-auth-token')}` };
  }
  async function sell(at: string, registerId: string, cashierRef: string, lines: Line[]) {
    // As v2's test: a v4 payload, whose discountMinor is tax-exclusive and becomes the TALLY-DISCOUNT surcharge.
    const command = orderCommand(lines, undefined, undefined, { version: 4 as never });
    Object.assign(command, { createdAt: at });
    Object.assign(command.payload, { createdAt: at, registerId, cashierRef });
    const result = await post(command);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    return result.serverRefs!.orderId;
  }
  async function readOrder(id: string): Promise<RawOrder> {
    const { order } = await adminClient.query<{ order: RawOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      id subTotalWithTax shippingWithTax customFields { tallyRegisterId tallyCashierRef }
      lines { quantity proratedLinePriceWithTax productVariant { id } }
    } }`), { id });
    return order;
  }
  async function report(path: string, params: Record<string, string>, token: Record<string, string> = reporter) {
    const response = await fetch(`${base}/tally/v1/${path}?${new URLSearchParams(params)}`, { headers: token });
    return { status: response.status, body: await response.json() };
  }
  async function v3(filter: Filter): Promise<TallySalesReportV3> {
    const { status, body } = await report('reports/sales/v3', { ...range, ...filter });
    expect(status, JSON.stringify(body)).toBe(200);
    return body;
  }
  const matching = (filter: Filter) => raw.filter(order =>
    (filter.registerId === undefined || order.customFields.tallyRegisterId === filter.registerId)
    && (filter.cashierId === undefined || order.customFields.tallyCashierRef === filter.cashierId));
  /** Categories worked out from the raw lines and the collections the fixture made. */
  function categories(filter: Filter) {
    const rows = new Map<string, TallySalesReportV3['categories'][number]>();
    const names = { [collections.kitchen]: 'Kitchen', [collections.gifts]: 'Gifts' };
    for (const line of matching(filter).flatMap(order => order.lines)) {
      for (const collectionId of membership.get(line.productVariant.id) ?? []) {
        const row = rows.get(collectionId) ?? rows.set(collectionId, { collectionId, name: names[collectionId], quantity: 0, salesMinor: 0 }).get(collectionId)!;
        row.quantity += line.quantity;
        row.salesMinor += line.proratedLinePriceWithTax;
      }
    }
    return [...rows.values()].sort((a, b) => b.salesMinor - a.salesMinor || (a.name < b.name ? -1 : 1));
  }

  it('reads back the fixture it was built from', () => {
    // Mug 800 + 25%; beans 500 and 900 + 10%; the discounted mug 700 + 25%. Shipping is the till's zero-priced line.
    expect(raw.map(order => order.subTotalWithTax + order.shippingWithTax)).toEqual([1000, 550, 875, 1540]);
    // The till discount is not in the line: lines are before the order discount, as products count them.
    expect(raw[2].lines[0].proratedLinePriceWithTax).toBe(1000);
  });

  it('is v2 plus the median, the largest order and categories, for the store, a register and a cashier', async () => {
    for (const filter of [{}, { registerId: registerA }, { cashierId: cashier2 }, { registerId: registerA, cashierId: cashier1 }] as Filter[]) {
      const { version, orders: { medianMinor, largestMinor, ...orders }, categories: rows, ...rest } = await v3(filter);
      const two = await report('reports/sales/v2', { ...range, ...filter });
      expect({ ...two.body, version }).toEqual({ ...rest, version: 3, orders });
      expect(rows, JSON.stringify(filter)).toEqual(categories(filter));
      const totals = matching(filter).map(order => order.subTotalWithTax + order.shippingWithTax);
      expect(largestMinor).toBe(Math.max(...totals));
      expect(two.body.orders.salesMinor).toBe(totals.reduce((sum, total) => sum + total, 0));
      expect(medianMinor).toBeGreaterThan(0);
    }
  });

  it('takes the middle of an odd count, and the mean of the two middles, half up, for an even count', async () => {
    // registerA: 550, 875, 1000.
    expect((await v3({ registerId: registerA })).orders).toMatchObject({ count: 3, medianMinor: 875, largestMinor: 1000 });
    // The store: 550, 875, 1000, 1540, so (875 + 1000) / 2 = 937.5, rounded up.
    expect((await v3({})).orders).toMatchObject({ count: 4, medianMinor: 938, largestMinor: 1540 });
    // cashier2: 875, 1540, so 1207.5 up to 1208; cashier1: 550, 1000, an exact 775.
    expect((await v3({ cashierId: cashier2 })).orders).toMatchObject({ count: 2, medianMinor: 1208, largestMinor: 1540 });
    expect((await v3({ cashierId: cashier1 })).orders).toMatchObject({ count: 2, medianMinor: 775, largestMinor: 1000 });
  });

  it('answers median 0, largest null and no categories with no orders', async () => {
    const body = await v3({ cashierId: 'nobody' });
    expect(body.orders).toMatchObject({ count: 0, medianMinor: 0, largestMinor: null });
    expect(body.categories).toEqual([]);
  });

  it('counts a product in each of its collections, a variant in none in none, on the pre-discount line basis', async () => {
    const body = await v3({});
    // Kitchen: two mugs (1000 each, the discounted one before its discount) and two 500 beans (550 each).
    // Gifts, private, as the app's category tiles keep private collections: the two mugs again.
    expect(body.categories).toEqual([
      { collectionId: collections.kitchen, name: 'Kitchen', quantity: 4, salesMinor: 3100 },
      { collectionId: collections.gifts, name: 'Gifts', quantity: 2, salesMinor: 2000 },
    ]);
    // The 900 beans sold, but are in no collection, so no category holds their 990.
    expect(body.products.find(row => row.productVariantId === variantIds.beans[1])).toMatchObject({ quantity: 1, salesMinor: 990 });
    // A register's filter applies to categories too: registerB sold no mug.
    expect((await v3({ registerId: registerB })).categories).toEqual([
      { collectionId: collections.kitchen, name: 'Kitchen', quantity: 1, salesMinor: 550 },
    ]);
  });

  it('has v2\'s permission and query answers', async () => {
    expect((await report('reports/sales/v3', range, {})).status).toBe(403);
    expect(await report('reports/sales/v3', range, await tokenWith(['TallyPosSell']))).toEqual({ status: 403,
      body: { code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' } });
    expect(await report('reports/sales/v3', { ...range, cashierId: '' })).toEqual({ status: 400,
      body: { code: 'invalid_query', message: 'cashierId must be 1 to 64 characters' } });
    expect(await report('reports/sales/v3', { to: range.to })).toEqual({ status: 400,
      body: { code: 'invalid_query', message: 'from must be an ISO date-time with an offset' } });
  });
});
