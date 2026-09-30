import { StockLevel, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrderCreateService } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { SECOND_INSTANCE, bootstrapSecondInstance, createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

// #62 gap 1: POS stock writes on one database lose no update when the sales go through two Vendure instances, or race
// Vendure's own sale path (a Shop API checkout), which does not take the plugin's stock lock (VP3-2).
describe('#62: stock with two Vendure instances on one database', () => {
  const override = { paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] } };
  const environment = createPluginTestEnvironment(override);
  const { server, adminClient, variantIds, serviceIds } = environment;
  let second: Awaited<ReturnType<typeof bootstrapSecondInstance>> | undefined;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let standardShippingId: string;
  let dummyPaymentCode: string;
  // Index 0 is the harness server (instance 1), index 1 the second instance.
  const instances: Array<{ base: string; token: string }> = [];
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    ({ standardShippingId, dummyPaymentCode } = await createStorefrontMethods(adminClient));
    second = await bootstrapSecondInstance(connection.rawConnection.options.database as string, override);
    const secondAdmin = new SimpleGraphQLClient(second.config, `${second.url}/admin-api`);
    await secondAdmin.asSuperAdmin();
    instances.push({ base: await server.app.getUrl(), token: adminClient.getAuthToken() },
      { base: second.url, token: secondAdmin.getAuthToken() });
  });
  afterEach(() => { recipe.testObserver = undefined; });
  afterAll(async () => {
    await second?.app.close();
    await server.destroy();
  });

  let sales = 0;
  const sale = (variantId: string, unitPriceMinor: number) => orderCommand([{ variantId, quantity: 1, unitPriceMinor }], undefined,
    { email: `i62-${++sales}-${Date.now()}@example.com` });
  // One command through the route of the given instance; answers its status, or the HTTP failure.
  async function post(instance: number, command: CommandEnvelope<OrderCreatePayload>) {
    const { base, token } = instances[instance];
    const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST', body: JSON.stringify({ commands: [command] }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tally-Protocol': '1' } });
    const body = await response.json() as { results?: Array<{ status: string }> };
    return body.results?.[0]?.status ?? `${response.status} ${JSON.stringify(body)}`;
  }
  async function setOnHand(id: string, stockOnHand: number) {
    await adminClient.query(parse(`mutation SetStock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id, stockOnHand }] });
  }
  async function level(productVariantId: string) {
    const levels = await connection.rawConnection.getRepository(StockLevel).find({ where: { productVariantId } });
    return { onHand: levels.reduce((sum, item) => sum + item.stockOnHand, 0),
      allocated: levels.reduce((sum, item) => sum + item.stockAllocated, 0) };
  }
  // Holds instance 1's sale at its first recipe line, after its stock rows are locked, until released (as in VP3-2).
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
  // VP3-2's stockLockWait, narrowed to a second-instance statement on stock_level waiting on an instance-1 backend.
  async function crossInstanceWait(limitMs: number) {
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      const rows = await connection.rawConnection.query(`SELECT waiter.pid FROM pg_stat_activity waiter
        CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocking(pid)
        JOIN pg_stat_activity holder ON holder.pid = blocking.pid
        WHERE waiter.datname = current_database() AND waiter.wait_event_type = 'Lock' AND waiter.state = 'active'
          AND waiter.query ILIKE '%stock_level%' AND waiter.application_name = $1 AND holder.application_name <> $1`,
      [SECOND_INSTANCE]);
      if (rows.length) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  it('A: eight POS sales alternating over two instances all apply; on-hand ends at exactly start - 8', async () => {
    const mug = variantIds.mug[0];
    const start = 20;
    await setOnHand(mug, start);
    expect(await level(serviceIds.mug[0])).toEqual({ onHand: start, allocated: 0 });
    const commands = Array.from({ length: 8 }, () => sale(mug, 800));
    // Instance 1's first sale holds the stock rows, so the second instance's sales must wait on it; then all race.
    const held = hold(commands[0]);
    const first = post(0, commands[0]);
    await held.reached;
    const rest = commands.slice(1).map((command, index) => post((index + 1) % 2, command));
    const crossed = await crossInstanceWait(3_000);
    held.release();
    const statuses = await Promise.all([first, ...rest]);
    expect({ crossed, statuses, ...await level(serviceIds.mug[0]) })
      .toEqual({ crossed: true, statuses: Array(8).fill('applied'), onHand: start - 8, allocated: 0 });
  });

  // K POS sales, split over both instances, race the payments of M Shop API guest checkouts, split likewise. Each Shop
  // order is brought to ArrangingPayment first: its stock write is the allocation on PaymentSettled (Vendure's default
  // flow takes on-hand only at fulfilment, which none reaches), so the payments are what race the POS sales.
  async function race(variantId: string, id: string, unitPriceMinor: number, start: number, posSales: number, shopSales: number) {
    await setOnHand(variantId, start);
    const before = await level(id);
    const shops = await Promise.all(Array.from({ length: shopSales }, async (_, index) => {
      const client = new SimpleGraphQLClient(second!.config, `${instances[index % 2].base}/shop-api`);
      const shop = await guestOrder(client, variantId, `i62-shop-${index}-${Date.now()}@example.com`);
      expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
      expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
      return shop;
    }));
    const [statuses, paid] = await Promise.all([
      Promise.all(Array.from({ length: posSales }, (_, index) => post(index % 2, sale(variantId, unitPriceMinor)))),
      Promise.all(shops.map(shop => shop.pay(dummyPaymentCode))),
    ]);
    // The Shop orders' own ALLOCATION movements (POS sales record theirs too).
    const [{ n: allocations }] = await connection.rawConnection.query(`SELECT count(*)::int AS n FROM stock_movement movement
      JOIN order_line line ON line.id = movement."orderLineId" JOIN "order" o ON o.id = line."orderId"
      WHERE movement.type = 'ALLOCATION' AND o.code = ANY($1)`, [paid.map(order => order.code)]) as Array<{ n: number }>;
    return { statuses, states: paid.map(order => order.state ?? order.errorCode), before, after: await level(id), allocations };
  }

  // Measured 2026-09-30, three runs of this race as a plain it() with K = M = 6: on-hand ended exact (44), every sale
  // applied and every checkout settled with its ALLOCATION movement, but stockAllocated ended at 1, not 6 (saleable 43,
  // not 38). The same loss shows with no POS sale at all, on one instance or two (six concurrent Shop settlements, six
  // movements, stockAllocated 1, four of four runs): Vendure's StockLevelService.updateStockAllocatedForLocation reads the level
  // unlocked and writes back stockAllocated + change. It is Vendure's own lost update, so this stays it.fails (#62).
  it.fails('B: POS sales on both instances race Shop API checkouts on both; no stock update is lost', async () => {
    const [start, posSales, shopSales] = [50, 6, 6];
    const { statuses, states, before, after } = await race(variantIds.print[0], serviceIds.print[0], 4500, start, posSales, shopSales);
    const settled = states.filter(state => state === 'PaymentSettled').length;
    expect({ statuses, states, before, onHand: after.onHand, allocated: after.allocated, saleable: after.onHand - after.allocated })
      .toEqual({ statuses: Array(posSales).fill('applied'), states: Array(shopSales).fill('PaymentSettled'),
        before: { onHand: start, allocated: 0 }, onHand: start - posSales, allocated: settled, saleable: start - posSales - settled });
  });

  // B's POS side, which it.fails above cannot guard: in the same race, every POS unit leaves on-hand exactly.
  it('B-pos: in the same race, on-hand ends at exactly start - K and every Shop settlement records its allocation', async () => {
    const [start, posSales, shopSales] = [50, 6, 6];
    const { statuses, states, before, after, allocations } = await race(variantIds.beans[0], serviceIds.beans[0], 500, start, posSales, shopSales);
    expect({ statuses, states, before, onHand: after.onHand, allocations }).toEqual({ statuses: Array(posSales).fill('applied'),
      states: Array(shopSales).fill('PaymentSettled'), before: { onHand: start, allocated: 0 }, onHand: start - posSales, allocations: shopSales });
  });
});
