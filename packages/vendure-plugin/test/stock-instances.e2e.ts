import { StockLevel, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrderCreateService } from '../src';
import type { OrderCreateResult } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { SECOND_INSTANCE, bootstrapSecondInstance, createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';
import type { ShopResult } from './shop';

// #62 gap 1: POS stock writes on one database lose no update when the sales go through two Vendure instances, or race
// Vendure's own sale path (a Shop API checkout), which takes the stock lock only through TallyStockLocationStrategy
// (#62 finding 5), not the recipe's own (VP3-2).
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
  // One command through the route of the given instance; answers its result, or the HTTP failure as its status.
  type Posted = { status: string; warnings?: OrderCreateResult['warnings'] };
  async function post(instance: number, command: CommandEnvelope<OrderCreatePayload>): Promise<Posted> {
    const { base, token } = instances[instance];
    const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST', body: JSON.stringify({ commands: [command] }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tally-Protocol': '1' } });
    const body = await response.json() as { results?: Posted[] };
    return body.results?.[0] ?? { status: `${response.status} ${JSON.stringify(body)}` };
  }
  const warned = (results: Posted[]) =>
    results.filter(result => result.warnings?.some(warning => warning.code === 'insufficient_stock')).length;
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

  // VP3-2 test 2 over two instances. Starting below the sales' units makes half of them top up, which is the write the
  // stock lock keeps from losing an update; from a start above them, a missing lock goes unseen (#62 review).
  it('A: eight POS sales from on-hand 4, alternating over two instances, all apply; on-hand ends at exactly -4', async () => {
    const mug = variantIds.mug[0];
    await setOnHand(mug, 4);
    expect(await level(serviceIds.mug[0])).toEqual({ onHand: 4, allocated: 0 });
    const commands = Array.from({ length: 8 }, () => sale(mug, 800));
    // Instance 1's first sale holds the stock rows, so the second instance's sales must wait on it; then all race.
    const held = hold(commands[0]);
    const first = post(0, commands[0]);
    await held.reached;
    const rest = commands.slice(1).map((command, index) => post((index + 1) % 2, command));
    const crossed = await crossInstanceWait(3_000);
    held.release();
    const results = await Promise.all([first, ...rest]);
    expect({ crossed, statuses: results.map(result => result.status), warned: warned(results), ...await level(serviceIds.mug[0]) })
      .toEqual({ crossed: true, statuses: Array(8).fill('applied'), warned: 4, onHand: -4, allocated: 0 });
  });

  // VP3-2 test 1 over two instances: from on-hand 0, both sales top up, and the second waits across instances for the first.
  it('A2: a sale on instance 2 waits on instance 1\'s held stock rows, and neither top-up is lost', async () => {
    const mug = variantIds.mug[0];
    await setOnHand(mug, 0);
    expect(await level(serviceIds.mug[0])).toEqual({ onHand: 0, allocated: 0 });
    const [a, b] = [sale(mug, 800), sale(mug, 800)];
    const held = hold(a);
    const first = post(0, a);
    await held.reached;
    const second = post(1, b);
    const crossed = await crossInstanceWait(3_000);
    held.release();
    const results = await Promise.all([first, second]);
    // A tops up 1 from on-hand 0 and leaves -1; B tops up 2 from -1 but warns for its own 1 unit (VP3-3).
    const warning = { code: 'insufficient_stock', variantId: mug, quantity: 1 };
    expect({ crossed, results: results.map(({ status, warnings }) => ({ status, warnings })), ...await level(serviceIds.mug[0]) })
      .toEqual({ crossed: true, results: Array(2).fill({ status: 'applied', warnings: [warning] }), onHand: -2, allocated: 0 });
  });

  // K POS sales, split over both instances, race the payments of M Shop API guest checkouts, split likewise. Each Shop
  // order is brought to ArrangingPayment first: its stock write is the allocation on PaymentSettled (Vendure's default
  // flow takes on-hand only at fulfilment, which none reaches), so the payments are what race the POS sales. `held`
  // forces the overlap: instance 1's first POS sale is held inside its transaction, with its stock rows locked, until a
  // Shop settlement on the second instance is seen waiting on them (crossed); then the other POS sales start and it is let go.
  async function race(variantId: string, id: string, unitPriceMinor: number, start: number, posSales: number, shopSales: number,
    held = false) {
    await setOnHand(variantId, start);
    const before = await level(id);
    const shops = await Promise.all(Array.from({ length: shopSales }, async (_, index) => {
      const client = new SimpleGraphQLClient(second!.config, `${instances[index % 2].base}/shop-api`);
      const shop = await guestOrder(client, variantId, `i62-shop-${index}-${Date.now()}@example.com`);
      expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
      expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
      return shop;
    }));
    const commands = Array.from({ length: posSales }, () => sale(variantId, unitPriceMinor));
    const posting = (from: number) => commands.slice(from).map((command, index) => post((from + index) % 2, command));
    let crossed: boolean | undefined;
    let selling: Promise<Posted[]> | undefined;
    let paying: Promise<ShopResult[]> | undefined;
    if (held) {
      const holding = hold(commands[0]);
      const first = post(0, commands[0]);
      await holding.reached;
      paying = Promise.all(shops.map(shop => shop.pay(dummyPaymentCode)));
      crossed = await crossInstanceWait(3_000);
      selling = Promise.all([first, ...posting(1)]);
      holding.release();
    }
    const [results, paid] = await Promise.all([
      selling ?? Promise.all(posting(0)),
      paying ?? Promise.all(shops.map(shop => shop.pay(dummyPaymentCode))),
    ]);
    // The Shop orders' own ALLOCATION movements (POS sales record theirs too).
    const [{ n: allocations }] = await connection.rawConnection.query(`SELECT count(*)::int AS n FROM stock_movement movement
      JOIN order_line line ON line.id = movement."orderLineId" JOIN "order" o ON o.id = line."orderId"
      WHERE movement.type = 'ALLOCATION' AND o.code = ANY($1)`, [paid.map(order => order.code)]) as Array<{ n: number }>;
    return { statuses: results.map(result => result.status), states: paid.map(order => order.state ?? order.errorCode), before,
      after: await level(id), allocations, crossed };
  }

  // Regression guard: measured on @vendure/core 3.7.3, three runs with K = M = 6 without the lock: on-hand ended exact (44),
  // every sale applied and every checkout settled with its ALLOCATION movement, but stockAllocated ended at 1, not 6
  // (saleable 43, not 38). The same loss showed with no POS sale at all, on one instance or two (six concurrent Shop
  // settlements, stockAllocated 1, four of four runs): Vendure's StockLevelService.updateStockAllocatedForLocation reads
  // the level unlocked and writes back stockAllocated + change. TallyStockLocationStrategy's lock now comes before that
  // read, on every instance (#62 finding 5).
  it('B: POS sales on both instances race Shop API checkouts on both; no stock update is lost', async () => {
    const [start, posSales, shopSales] = [50, 6, 6];
    const { statuses, states, before, after } = await race(variantIds.print[0], serviceIds.print[0], 4500, start, posSales, shopSales);
    const settled = states.filter(state => state === 'PaymentSettled').length;
    expect({ statuses, states, before, onHand: after.onHand, allocated: after.allocated, saleable: after.onHand - after.allocated })
      .toEqual({ statuses: Array(posSales).fill('applied'), states: Array(shopSales).fill('PaymentSettled'),
        before: { onHand: start, allocated: 0 }, onHand: start - posSales, allocated: settled, saleable: start - posSales - settled });
  });

  // B's race from below K, so the POS sales top up while the settlements race, with the overlap forced: a Shop
  // settlement is seen waiting on a held POS sale's stock rows. `crossed` stays true without the locks too (the
  // settlement's own UPDATE would wait on the POS sale's row lock), so the value assertions are what catch a missing lock:
  // on-hand exact, and stockAllocated equal to the settlements' ALLOCATION movements. The test store's
  // MultiChannelStockLocationStrategy plans only available stock, so once the 3 units are taken a settlement allocates
  // nothing; without the lock every settlement read the same unlocked level, allocated, and most of those writes were lost.
  it('B-pos: from on-hand 3, a held POS sale blocks a Shop settlement; on-hand ends at 3 - K, allocated at its movements', async () => {
    const [start, posSales, shopSales] = [3, 6, 6];
    const { statuses, states, before, after, allocations, crossed } =
      await race(variantIds.beans[0], serviceIds.beans[0], 500, start, posSales, shopSales, true);
    // The settlement seen waiting is queued on the rows before the other POS sales start, so at least it allocates.
    expect({ crossed, statuses, states, before, onHand: after.onHand, allocated: after.allocated, allocating: allocations > 0 })
      .toEqual({ crossed: true, statuses: Array(posSales).fill('applied'), states: Array(shopSales).fill('PaymentSettled'),
        before: { onHand: start, allocated: 0 }, onHand: start - posSales, allocated: allocations, allocating: true });
  });
});
