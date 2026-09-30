import { ChannelService, Customer, Order,ProductVariantService, RequestContextService, TransactionalConnection, User } from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin, TransientCommandError } from '../src';
import type { OrderCreateResult } from '../src';
import { WALK_IN_EMAIL } from '../src/service/constants';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// VP3-4b (Front desk rulings 8 and 14, VP3 investigation Q3): concurrent sales for one customer never wait unbounded,
// never answer 503 on the channel link, and never create two customers for one email. Each pair sells different
// variants, so the stock lock cannot be what serialises them.
describe('VP3-4b: concurrent customer lookups', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let second: { id: string; token: string };
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    const { zones } = await adminClient.query<{ zones: { items: Array<{ id: string; name: string }> } }>(
      parse('query { zones { items { id name } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) {
        createChannel(input: $input) { ... on Channel { id token } ... on ErrorResult { message } }
      }`), { input: {
      code: 'vp3-4b-second', token: 'vp3-4b-second-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    second = { id: decode(createChannel.id), token: createChannel.token };
    await server.app.get(TallyPosPlugin).onApplicationBootstrap();
    // The second channel sells the Mug and the Print, untracked because it has no stock location of its own.
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    await server.app.get(ProductVariantService).assignProductVariantsToChannel(ctx, {
      productVariantIds: [serviceIds.mug[0], serviceIds.print[0]], channelId: second.id,
    });
    await adminClient.query(parse(`mutation Untrack($input: [UpdateProductVariantInput!]!) { updateProductVariants(input: $input) { id } }`),
      { input: [variantIds.mug[0], variantIds.print[0]].map(id => ({ id, trackInventory: 'FALSE' })) });
  });
  afterEach(() => { recipe.testObserver = undefined; vi.restoreAllMocks(); });
  afterAll(() => server.destroy());

  const mug = (email?: string) => orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined,
    email ? { email } : undefined);
  const print = (email?: string) => orderCommand([{ variantId: variantIds.print[0], quantity: 1, unitPriceMinor: 4500 }], undefined,
    email ? { email } : undefined);
  const timed = async <T>(work: Promise<T>) => {
    const start = performance.now();
    const settled = await work.then(value => ({ value }), (error: unknown) => ({ error }));
    return { ...settled, ms: Math.round(performance.now() - start) } as { value?: T; error?: unknown; ms: number };
  };
  const status = (settled: { value?: OrderCreateResult; error?: unknown }) => settled.value?.status ?? String(settled.error);
  // Holds the sale's transaction (customer found or created, linked, order saved) at its first line until released.
  function hold(input: CommandEnvelope<OrderCreatePayload>) {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'addItemToOrder' && order.customFields.tallyClientOrderId === input.payload.clientOrderId) {
        entered();
        await released;
      }
    };
    return { reached, release };
  }
  // Polls pg_stat_activity, on a pooled connection outside every sale, until a statement matching the pattern waits on a lock.
  async function lockWait(pattern: string, limitMs: number) {
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      const rows = await connection.rawConnection.query(`SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`, [pattern]);
      if (rows.length) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }
  async function orderCustomer(result: OrderCreateResult | undefined) {
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result!.serverRefs!.orderId) }, relations: ['customer'],
    });
    return String(order.customer!.id);
  }

  it('1: a walk-in sale in an assigned channel is not serialised behind another held walk-in sale', async () => {
    const a = mug();
    const b = print();
    const held = hold(a);
    const first = timed(run(a));
    await held.reached;
    let quick: { value?: OrderCreateResult; error?: unknown; ms: number } | 'late';
    try {
      quick = await Promise.race([timed(run(b)), new Promise<'late'>(resolve => setTimeout(() => resolve('late'), 3_000))]);
    } finally {
      held.release();
    }
    expect(quick === 'late' ? 'late' : status(quick)).toBe('applied');
    expect(status(await first)).toBe('applied');
  });

  it('2: an email customer from channel 1, sold concurrently in channel 2, links once and both sales apply', async () => {
    const email = `vp3-4b-link-${Date.now()}@example.com`;
    const created = await run(mug(email));
    expect(created).toMatchObject({ status: 'applied' });
    const customerId = await orderCustomer(created);
    const links = async () => (await connection.rawConnection.query(
      'SELECT count(*)::int AS n FROM customer_channels_channel WHERE "customerId" = $1 AND "channelId" = $2',
      [customerId, second.id]) as Array<{ n: number }>)[0].n;
    expect(await links()).toBe(0);
    const a = mug(email);
    const b = print(email);
    const held = hold(a);
    const first = timed(run(a, second.token));
    await held.reached;
    const secondSale = timed(run(b, second.token));
    const blocked = await lockWait('%customer_channels_channel%', 3_000);
    held.release();
    const results = await Promise.all([first, secondSale]);
    expect({ blocked, results: results.map(status), links: await links() })
      .toEqual({ blocked: true, results: ['applied', 'applied'], links: 1 });
    expect(await Promise.all(results.map(result => orderCustomer(result.value)))).toEqual([customerId, customerId]);
  });

  it('3: two concurrent first sales with one new email create one customer, the second waiting on the advisory lock', async () => {
    const email = `vp3-4b-new-${Date.now()}@example.com`;
    const a = mug(email);
    const b = print(email);
    const held = hold(a);
    const first = timed(run(a));
    await held.reached;
    const secondSale = timed(run(b));
    const blocked = await lockWait('%pg_advisory_xact_lock%', 3_000);
    held.release();
    const results = await Promise.all([first, secondSale]);
    const customers = await connection.rawConnection.getRepository(Customer).find({ where: { emailAddress: email, deletedAt: IsNull() } });
    expect({ blocked, results: results.map(status), customers: customers.length })
      .toEqual({ blocked: true, results: ['applied', 'applied'], customers: 1 });
    const id = String(customers[0].id);
    expect(await Promise.all(results.map(result => orderCustomer(result.value)))).toEqual([id, id]);
  });

  it('ruling 15: a new-id resend of an in-progress first sale for a new email answers 503 timeout; after commit the retry returns the recorded result', async () => {
    const email = `vp3-4b-resend-${Date.now()}@example.com`;
    const a = mug(email);
    const requeued = { ...a, id: mug().id };
    const held = hold(a);
    const first = timed(run(a));
    await held.reached;
    let second: { value?: OrderCreateResult; error?: unknown; ms: number };
    try {
      second = await timed(run(requeued));
    } finally {
      held.release();
    }
    // The per-email lock cannot tell a resend from another sale by the same new buyer: the generic transient (503).
    expect(second.error).toBeInstanceOf(TransientCommandError);
    expect(second.error).toMatchObject({ commandId: requeued.id, kind: 'timeout' });
    expect(second.ms).toBeGreaterThanOrEqual(9_000);
    expect(second.ms).toBeLessThanOrEqual(13_000);
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: requeued.id })).toBeNull();
    const applied = (await first).value!;
    expect(applied).toMatchObject({ status: 'applied' });
    expect(await run(requeued)).toMatchObject({ id: requeued.id, status: 'applied', serverRefs: applied.serverRefs });
    expect({
      customers: await connection.rawConnection.getRepository(Customer).count({ where: { emailAddress: email, deletedAt: IsNull() } }),
      orders: await connection.rawConnection.getRepository(Order).count({
        where: { customFields: { tallyClientOrderId: a.payload.clientOrderId } },
      }),
    }).toEqual({ customers: 1, orders: 1 });
  });

  it('#22 nit 1: a stored mixed-case email is found; no second customer', async () => {
    // A row stored before Vendure normalised emails, or imported, keeps its case.
    const inserted = await connection.rawConnection.getRepository(Customer).save(new Customer({
      emailAddress: 'Mixed.Case@Example.com', firstName: 'Mixed', lastName: 'Case',
      channels: [await server.app.get(ChannelService).getDefaultChannel()],
    }));
    const sale = await run(mug('mixed.case@example.com'));
    expect(sale).toMatchObject({ status: 'applied' });
    expect(await orderCustomer(sale)).toBe(String(inserted.id));
    expect((await connection.rawConnection.query(`SELECT count(*)::int AS n FROM customer
      WHERE LOWER("emailAddress") = 'mixed.case@example.com' AND "deletedAt" IS NULL`) as Array<{ n: number }>)[0].n).toBe(1);
  });

  it('#24 1: Jane@Localhost and jane@localhost (not lowercased by Vendure) share the advisory lock: one customer', async () => {
    const a = mug('Jane@Localhost');
    const b = print('jane@localhost');
    const held = hold(a);
    const first = timed(run(a));
    await held.reached;
    const secondSale = timed(run(b));
    const blocked = await lockWait('%pg_advisory_xact_lock%', 3_000);
    held.release();
    const results = await Promise.all([first, secondSale]);
    const customers = (await connection.rawConnection.query(`SELECT count(*)::int AS n FROM customer
      WHERE LOWER("emailAddress") = 'jane@localhost' AND "deletedAt" IS NULL`) as Array<{ n: number }>)[0].n;
    expect({ blocked, results: results.map(status), customers }).toEqual({ blocked: true, results: ['applied', 'applied'], customers: 1 });
  });

  const walkInCustomer = async (id: string) => await connection.rawConnection.getRepository(Customer).findOneByOrFail({ id });

  it('ruling 16: a second walk-in sale loads the cached walk-in by primary key and skips the email query', async () => {
    const lookups = vi.spyOn(recipe as unknown as { findByEmail: () => Promise<unknown> }, 'findByEmail');
    const first = await run(mug());
    const before = lookups.mock.calls.length;
    const second = await run(mug());
    expect({ first: first.status, second: second.status, lookups: lookups.mock.calls.length - before })
      .toEqual({ first: 'applied', second: 'applied', lookups: 0 });
    const [one, two] = [await orderCustomer(first), await orderCustomer(second)];
    expect({ same: one === two, email: (await walkInCustomer(two)).emailAddress }).toEqual({ same: true, email: WALK_IN_EMAIL });
  });

  it('ruling 16: a soft-deleted cached walk-in is not used; the next walk-in sale uses a live walk-in', async () => {
    const warm = await run(mug()); // The cache holds this walk-in's id.
    const deleted = await orderCustomer(warm);
    await connection.rawConnection.query('UPDATE customer SET "deletedAt" = now() WHERE id = $1', [deleted]);
    const sale = await run(mug());
    expect(sale).toMatchObject({ status: 'applied' });
    const used = await orderCustomer(sale);
    const row = await walkInCustomer(used);
    expect({ other: used !== deleted, email: row.emailAddress, deletedAt: row.deletedAt })
      .toEqual({ other: true, email: WALK_IN_EMAIL, deletedAt: null });
  });

  it('#24 5: of two stored case twins the lower id wins; neither changes and no third customer is made', async () => {
    const customers = connection.rawConnection.getRepository(Customer);
    const channel = await server.app.get(ChannelService).getDefaultChannel();
    const twin = (emailAddress: string, firstName: string) =>
      customers.save(new Customer({ emailAddress, firstName, lastName: 'Twin', channels: [channel] }));
    const older = await twin('Case.Twin@Example.com', 'Older');
    const newer = await twin('case.twin@example.com', 'Newer');
    const sale = await run(mug('CASE.TWIN@example.com'));
    expect(sale).toMatchObject({ status: 'applied' });
    expect(await orderCustomer(sale)).toBe(String(older.id));
    const rows = await connection.rawConnection.query(`SELECT id::text, "emailAddress", "firstName", "lastName" FROM customer
      WHERE LOWER("emailAddress") = 'case.twin@example.com' AND "deletedAt" IS NULL ORDER BY customer.id`);
    expect(rows).toEqual([
      { id: String(older.id), emailAddress: 'Case.Twin@Example.com', firstName: 'Older', lastName: 'Twin' },
      { id: String(newer.id), emailAddress: 'case.twin@example.com', firstName: 'Newer', lastName: 'Twin' },
    ]);
  });
});
