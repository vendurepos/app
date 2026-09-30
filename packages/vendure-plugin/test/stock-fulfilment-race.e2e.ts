import { StockLevel, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import { parse } from 'graphql';
import type { EntitySubscriberInterface, QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrderCreateService } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment, pluginTestConfig } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

// #62 finding 4: Vendure's StockLevelService writes stockOnHand and stockAllocated as `read unlocked, write read + change`
// (stock-level.service.js:116-152), so a Vendure stock write that reads before a POS sale commits and writes after it
// could erase the POS sale's write, whatever lock the plugin takes on its own side (VP3-2). #62 finding 5: the plugin's
// TallyStockLocationStrategy locks the order's stock_level rows before each such write, so none is lost (ADR 0002).
describe('#62 finding 4: Vendure fulfilment and cancellation writes racing a POS sale', () => {
  const override = { paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] } };
  const environment = createPluginTestEnvironment(override);
  const { server, adminClient, shopClient, variantIds, serviceIds, run } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let standardShippingId: string;
  let dummyPaymentCode: string;
  let mug: string; // as commands and the APIs carry it
  let mugId: string; // decoded, for repositories
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    ({ standardShippingId, dummyPaymentCode } = await createStorefrontMethods(adminClient));
    mug = variantIds.mug[0];
    mugId = serviceIds.mug[0];
  });
  afterEach(() => { recipe.testObserver = undefined; });
  afterAll(() => server.destroy());

  let sales = 0;
  const sale = () => orderCommand([{ variantId: mug, quantity: 1, unitPriceMinor: 800 }], undefined,
    { email: `f62-${++sales}-${Date.now()}@example.com` });
  const admin = async (document: string, variables: Record<string, unknown>) =>
    Object.values(await adminClient.query<Record<string, { id: string; state?: string; errorCode?: string; message?: string }>>(
      parse(document), variables))[0];
  const RESULT = '... on ErrorResult { errorCode message }';
  const outcome = (result: { state?: string; errorCode?: string; message?: string }) =>
    result.state ?? `${result.errorCode}: ${result.message}`;
  async function setOnHand(stockOnHand: number, id = mug) {
    await admin(`mutation SetStock($input: [UpdateProductVariantInput!]!) { updateProductVariants(input: $input) { id } }`,
      { input: [{ id, stockOnHand }] });
  }
  async function level(productVariantId = mugId) {
    const levels = await connection.rawConnection.getRepository(StockLevel).find({ where: { productVariantId } });
    return { onHand: levels.reduce((sum, item) => sum + item.stockOnHand, 0),
      allocated: levels.reduce((sum, item) => sum + item.stockAllocated, 0) };
  }
  async function lastMovement() {
    const [{ id }] = await connection.rawConnection.query('SELECT coalesce(max(id), 0)::int AS id FROM stock_movement') as Array<{ id: number }>;
    return id;
  }
  // The variant's stock movements after the given id: type, quantity, and whose order (POS or Shop) they belong to.
  async function movementsAfter(id: number) {
    const rows = await connection.rawConnection.query(`SELECT movement.type, movement.quantity, o.code, o."customFieldsTallyclientorderid" AS pos
      FROM stock_movement movement LEFT JOIN order_line line ON line.id = movement."orderLineId" LEFT JOIN "order" o ON o.id = line."orderId"
      WHERE movement."productVariantId" = $1 AND movement.id > $2 ORDER BY movement.id`, [mugId, id]) as
      Array<{ type: string; quantity: number; code: string | null; pos: string | null }>;
    return rows.map(row => `${row.pos ? 'POS' : row.code ? 'Shop' : 'admin'} ${row.type} ${row.quantity}`);
  }
  // The level as the variant's movements sum it: on-hand from adjustments, sales (negative), cancellations and returns;
  // allocated from allocations, sales (negative) and releases (subtracted), as StockMovementService writes them.
  async function ledger(productVariantId = mugId) {
    const [sums] = await connection.rawConnection.query(`SELECT
        coalesce(sum(quantity) FILTER (WHERE type IN ('ADJUSTMENT', 'SALE', 'CANCELLATION', 'RETURN')), 0)::int AS "onHand",
        (coalesce(sum(quantity) FILTER (WHERE type IN ('ALLOCATION', 'SALE')), 0)
          - coalesce(sum(quantity) FILTER (WHERE type = 'RELEASE'), 0))::int AS allocated
      FROM stock_movement WHERE "productVariantId" = $1`, [productVariantId]) as Array<{ onHand: number; allocated: number }>;
    return { movements: sums, level: await level(productVariantId) };
  }

  // A Shop API guest order for one of each variant (one Mug by default), in that line order, paid and settled (Vendure
  // allocates it on PaymentSettled); its order line ids, in the same order.
  async function settledShopOrder(variants = [mug]) {
    const shop = await guestOrder(shopClient, variants[0], `f62-shop-${++sales}-${Date.now()}@example.com`);
    for (const id of variants.slice(1)) {
      await shopClient.query(parse(`mutation($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { id } } }`), { id });
    }
    expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
    expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
    const paid = await shop.pay(dummyPaymentCode);
    expect(paid.state).toBe('PaymentSettled');
    const { order } = await adminClient.query<{ order: { lines: Array<{ id: string; productVariant: { id: string } }> } }>(
      parse(`query($id: ID!) { order(id: $id) { lines { id productVariant { id } } } }`), { id: paid.id });
    const lineIds = variants.map(id => order.lines.find(line => line.productVariant.id === id)!.id);
    return { orderId: paid.id!, lineId: lineIds[0], lineIds };
  }
  const fulfil = (...lineIds: string[]) => admin(`mutation($lines: [OrderLineInput!]!) { addFulfillmentToOrder(input: {
    lines: $lines,
    handler: { code: "manual-fulfillment", arguments: [{ name: "method", value: "Post" }, { name: "trackingCode", value: "" }] }
  }) { ... on Fulfillment { id state } ${RESULT} } }`, { lines: lineIds.map(orderLineId => ({ orderLineId, quantity: 1 })) });
  const transitionFulfillment = (id: string, state: string) => admin(`mutation($id: ID!, $state: String!) {
    transitionFulfillmentToState(id: $id, state: $state) { ... on Fulfillment { id state } ${RESULT} } }`, { id, state });
  const cancelOrder = (orderId: string) => admin(`mutation($orderId: ID!) {
    cancelOrder(input: { orderId: $orderId }) { ... on Order { id state } ${RESULT} } }`, { orderId });

  // Each scenario prepares a Shop order, then races one Vendure Admin API write on it against a POS sale of the same
  // variant. `expected` is the change the two should make together when no update is lost.
  type Prepared = { orderId: string; lineId: string; fulfillmentId?: string };
  const scenarios = {
    // F: fulfilling a settled Shop order; creating the fulfilment (Created -> Pending) writes the Sale: allocated -1, on-hand -1.
    F: {
      prepare: settledShopOrder,
      act: async ({ lineId }: Prepared) => {
        const fulfillment = await fulfil(lineId);
        if (!fulfillment.state) return outcome(fulfillment);
        return outcome(await transitionFulfillment(fulfillment.id, 'Shipped'));
      },
      expected: { onHand: -2, allocated: -1 },
    },
    // C: cancelling a settled, unfulfilled Shop order releases its allocation: allocated -1.
    C: {
      prepare: settledShopOrder,
      act: async ({ orderId }: Prepared) => outcome(await cancelOrder(orderId)),
      expected: { onHand: -1, allocated: -1 },
    },
    // R: cancelling a delivered Shop order restocks it (a Cancellation): on-hand +1.
    R: {
      prepare: async () => {
        const order = await settledShopOrder();
        const fulfillment = await fulfil(order.lineId);
        expect(outcome(await transitionFulfillment(fulfillment.id, 'Delivered'))).toBe('Delivered');
        return order;
      },
      act: async ({ orderId }: Prepared) => outcome(await cancelOrder(orderId)),
      expected: { onHand: 0, allocated: 0 },
    },
    // Rf: cancelling a shipped fulfilment restocks it (a Cancellation, on-hand +1) and allocates the line again (+1).
    Rf: {
      prepare: async (): Promise<Prepared> => {
        const order = await settledShopOrder();
        const fulfillment = await fulfil(order.lineId);
        expect(outcome(await transitionFulfillment(fulfillment.id, 'Shipped'))).toBe('Shipped');
        return { ...order, fulfillmentId: fulfillment.id };
      },
      act: async ({ fulfillmentId }: Prepared) => outcome(await transitionFulfillment(fulfillmentId!, 'Cancelled')),
      expected: { onHand: 0, allocated: 1 },
    },
  };

  // Holds the POS sale right after its own on-hand write (the Sale its in-store fulfilment records), before it commits.
  // A test-only subscriber on StockLevel, matched to the sale's own query runner, awaits the release in afterUpdate.
  function holdAfterOnHandWrite(input: CommandEnvelope<OrderCreatePayload>) {
    let runner: QueryRunner | undefined;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    // The payments stage is the last observer stage before the fulfilment, and carries the sale's transaction.
    recipe.testObserver = async (stage, ctx, order) => {
      if (stage === 'payments' && order.customFields.tallyClientOrderId === input.payload.clientOrderId) {
        runner = connection.getRepository(ctx, StockLevel).manager.queryRunner;
      }
    };
    const subscriber: EntitySubscriberInterface<StockLevel> = {
      listenTo: () => StockLevel,
      afterUpdate: async event => {
        if (!runner || event.queryRunner !== runner || !event.entity || !('stockOnHand' in event.entity)) return;
        runner = undefined;
        entered();
        await released;
      },
    };
    const subscribers = connection.rawConnection.subscribers;
    subscribers.push(subscriber);
    return { reached, release: () => {
      release();
      subscribers.splice(subscribers.indexOf(subscriber), 1);
    } };
  }
  // Polls pg_stat_activity, outside every transaction, for a statement on stock_level waiting on a lock; answers it.
  async function stockLockWait(limitMs: number) {
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      const rows = await connection.rawConnection.query(`SELECT waiter.query FROM pg_stat_activity waiter
        WHERE waiter.datname = current_database() AND waiter.wait_event_type = 'Lock' AND waiter.state = 'active'
          AND waiter.query ILIKE '%stock_level%' AND cardinality(pg_blocking_pids(waiter.pid)) > 0`) as Array<{ query: string }>;
      if (rows.length) return rows[0].query.replace(/\s+/g, ' ').slice(0, 80);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
  }

  // Deterministic: the POS sale is held after its on-hand write; the Vendure write starts, reads the committed level,
  // and must wait on the sale's row lock for its UPDATE; then the sale is released and commits first.
  async function heldRace(key: keyof typeof scenarios) {
    const scenario = scenarios[key];
    await setOnHand(100);
    const prepared = await scenario.prepare();
    const before = await level();
    const mark = await lastMovement();
    const input = sale();
    const held = holdAfterOnHandWrite(input);
    const pos = run(input);
    await held.reached;
    const vendure = scenario.act(prepared);
    const waiting = await stockLockWait(5_000);
    held.release();
    const [result, state] = await Promise.all([pos, vendure]);
    const after = await level();
    const report = { key, waiting, pos: result.status, vendure: state, before, after,
      change: { onHand: after.onHand - before.onHand, allocated: after.allocated - before.allocated },
      expected: scenario.expected, movements: await movementsAfter(mark), ledger: await ledger() };
    console.log(`#62 held race ${JSON.stringify(report)}`);
    return report;
  }

  it('held F: fulfilling a Shop order while a POS sale commits loses no stock update', async () => {
    const report = await heldRace('F');
    expect(report).toMatchObject({ waiting: expect.stringContaining('"stock_level"'), pos: 'applied', vendure: 'Shipped',
      change: scenarios.F.expected });
  });

  it('held C: cancelling a settled Shop order while a POS sale commits loses no stock update', async () => {
    const report = await heldRace('C');
    expect(report).toMatchObject({ waiting: expect.stringContaining('"stock_level"'), pos: 'applied', vendure: 'Cancelled',
      change: scenarios.C.expected });
  });

  // Regression guard: measured on @vendure/core 3.7.3, on-hand 99 -> 100 (not 99 -> 99) in four of four runs without the
  // lock. The cancellation's UPDATE waited on the POS sale's row lock, then wrote the on-hand it had read before the sale
  // committed, erasing the sale's -1, though its SALE movement stood (movements summed to 99, the level said 100). F and
  // C lose nothing even without it: their first write on the row is stockAllocated, which a POS sale leaves as it found
  // it (+1 allocation, -1 sale), and every later write in their transaction reads under their own row lock. With the
  // strategy's lock, the cancellation waits at its SELECT ... FOR UPDATE instead, before it reads.
  it('held R: cancelling a delivered Shop order while a POS sale commits loses no stock update', async () => {
    const report = await heldRace('R');
    expect(report).toMatchObject({ waiting: expect.stringContaining('"stock_level"'), pos: 'applied', vendure: 'Cancelled',
      change: scenarios.R.expected });
  });

  // Regression guard: measured on @vendure/core 3.7.3, on-hand 99 -> 100 (not 99 -> 99) in four of four runs without the
  // lock: the fulfilment's Cancellation (+1) overwrote the POS sale's -1. Its re-allocation (allocated 0 -> 1), read
  // under its own row lock, was right.
  it('held Rf: cancelling a shipped fulfilment while a POS sale commits loses no stock update', async () => {
    const report = await heldRace('Rf');
    expect(report).toMatchObject({ waiting: expect.stringContaining('"stock_level"'), pos: 'applied', vendure: 'Cancelled',
      change: scenarios.Rf.expected });
  });

  // Statistical: N unheld pairs, each a POS sale and the Vendure write started together, the Vendure write delayed by
  // i/N of a solo POS sale's duration so the pairs sweep the sale's transaction. Counts the pairs that lose an update.
  const PAIRS = 20;
  async function unheldRaces(key: keyof typeof scenarios) {
    const scenario = scenarios[key];
    const prepared: Prepared[] = [];
    for (let index = 0; index < PAIRS; index++) prepared.push(await scenario.prepare());
    await setOnHand(500);
    const solo = performance.now();
    expect((await run(sale())).status).toBe('applied');
    const duration = performance.now() - solo;
    const pairs: Array<{ delayMs: number; onHandError: number; allocatedError: number; pos: string; vendure: string }> = [];
    for (let index = 0; index < PAIRS; index++) {
      const before = await level();
      const delayMs = Math.round(index * duration / PAIRS);
      const [result, state] = await Promise.all([run(sale()),
        new Promise(resolve => setTimeout(resolve, delayMs)).then(() => scenario.act(prepared[index]))]);
      const after = await level();
      pairs.push({ delayMs, pos: result.status, vendure: state,
        onHandError: after.onHand - before.onHand - scenario.expected.onHand,
        allocatedError: after.allocated - before.allocated - scenario.expected.allocated });
    }
    const report = { key, pairs: PAIRS, soloMs: Math.round(duration),
      lostOnHand: pairs.filter(pair => pair.onHandError !== 0).length,
      lostAllocated: pairs.filter(pair => pair.allocatedError !== 0).length,
      failed: pairs.filter(pair => pair.pos !== 'applied' || !['Shipped', 'Cancelled'].includes(pair.vendure)).length,
      errors: pairs.filter(pair => pair.onHandError || pair.allocatedError)
        .map(pair => `${pair.delayMs}ms:${pair.onHandError}/${pair.allocatedError}`),
      ledger: await ledger() };
    console.log(`#62 unheld races ${JSON.stringify(report)}`);
    return report;
  }

  for (const key of ['F', 'C'] as const) {
    it(`unheld ${key}: ${PAIRS} concurrent pairs lose no stock update`, async () => {
      expect(await unheldRaces(key)).toMatchObject({ lostOnHand: 0, lostAllocated: 0, failed: 0 });
    });
  }

  // Regression guard: measured on @vendure/core 3.7.3, four runs of 20 pairs each without the lock: R lost the POS sale's
  // on-hand -1 in 17, 12, 16 and 17 pairs, Rf in 13, 17, 16 and 15; every loss exactly one unit, every sale applied and
  // every cancellation done. Pairs lost when the Vendure write started from about 10 ms into the POS sale to about its
  // end; with no delay it committed before the sale locked the row.
  for (const key of ['R', 'Rf'] as const) {
    it(`unheld ${key}: ${PAIRS} concurrent pairs lose no stock update`, async () => {
      expect(await unheldRaces(key)).toMatchObject({ lostOnHand: 0, lostAllocated: 0, failed: 0 });
    });
  }

  // Regression guard: measured on @vendure/core 3.7.3, allocated +1 (not +6) without the lock, the ledger's allocated 27
  // against a level of 22 (#62 finding 4). Vendure's own settlements, no POS sale: each read stockAllocated unlocked and
  // wrote back read + 1. The strategy's lock is taken on PaymentSettled, before that read.
  it('Shop vs Shop: six concurrent Shop settlements of one variant allocate exactly +6', async () => {
    const base = await server.app.getUrl();
    const shops: Array<Awaited<ReturnType<typeof guestOrder>>> = [];
    for (let index = 0; index < 6; index++) {
      const client = new SimpleGraphQLClient(pluginTestConfig(override), `${base}/shop-api`);
      const shop = await guestOrder(client, mug, `f62-shops-${++sales}-${Date.now()}@example.com`);
      expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
      expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
      shops.push(shop);
    }
    const before = await level();
    const paid = await Promise.all(shops.map(shop => shop.pay(dummyPaymentCode)));
    const after = await level();
    expect({ states: paid.map(order => order.state ?? order.errorCode), onHand: after.onHand - before.onHand,
      allocated: after.allocated - before.allocated })
      .toEqual({ states: Array(6).fill('PaymentSettled'), onHand: 0, allocated: 6 });
  });

  // Holds each writer after its first stock_level UPDATE until another writer has made its own, or for holdMs. Without
  // an order-wide lock, a writer of lines [A, B] then holds A's row and one of [B, A] holds B's, and each next waits on
  // the other's: a Postgres deadlock (40P01), every time. With the strategy's lock, the second writer waits at its
  // SELECT ... FOR UPDATE on the order's rows before any UPDATE, so the hold times out and the writers serialise.
  function crossingBarrier(holdMs: number) {
    const arrived = new Set<QueryRunner>();
    let meet!: () => void;
    const met = new Promise<void>(resolve => { meet = resolve; });
    const subscriber: EntitySubscriberInterface<StockLevel> = {
      listenTo: () => StockLevel,
      afterUpdate: async event => {
        if (!event.queryRunner || arrived.has(event.queryRunner)) return;
        arrived.add(event.queryRunner);
        if (arrived.size === 2) meet();
        await Promise.race([met, new Promise(resolve => setTimeout(resolve, holdMs))]);
      },
    };
    const subscribers = connection.rawConnection.subscribers;
    subscribers.push(subscriber);
    return () => { subscribers.splice(subscribers.indexOf(subscriber), 1); };
  }

  // #62 finding 5: Vendure calls the strategy per order line, in line order, so a per-line lock would lock two orders
  // listing A, B and B, A in opposite orders. Each round: two settled Shop orders, one [A, B] and one [B, A], cancelled
  // (even rounds: Releases) or fulfilled (odd rounds: Sales) concurrently, through the crossing barrier.
  const ROUNDS = 10;
  it(`deadlock: ${ROUNDS} rounds of orders [A, B] and [B, A] cancelled or fulfilled together all succeed, stock exact`, async () => {
    const [a, b] = [variantIds.print[0], variantIds.beans[0]];
    const [aId, bId] = [serviceIds.print[0], serviceIds.beans[0]];
    await setOnHand(1000, a);
    await setOnHand(1000, b);
    const rounds: Array<{ results: string[]; waiting: boolean; a: object; b: object }> = [];
    for (let round = 0; round < ROUNDS; round++) {
      const before = { a: await level(aId), b: await level(bId) };
      const orders = [await settledShopOrder([a, b]), await settledShopOrder([b, a])];
      const fulfilling = round % 2 === 1;
      const remove = crossingBarrier(1_000);
      try {
        const acts = orders.map(order => (fulfilling ? fulfil(...order.lineIds) : cancelOrder(order.orderId))
          .then(outcome, (error: Error) => `error: ${error.message}`));
        // The writers overlap: while one holds the barrier, the other waits on a stock_level lock.
        const [results, waiting] = await Promise.all([Promise.all(acts), stockLockWait(1_000)]);
        const after = { a: await level(aId), b: await level(bId) };
        const change = (key: 'a' | 'b') => ({ onHand: after[key].onHand - before[key].onHand,
          allocated: after[key].allocated - before[key].allocated });
        rounds.push({ results, waiting: waiting !== null, a: change('a'), b: change('b') });
      } finally {
        remove();
      }
    }
    console.log(`#62 deadlock rounds ${JSON.stringify(rounds)}`);
    // From before the settlements. Cancelled: the Releases take the allocations back, on-hand unchanged. Fulfilled: the
    // Sales take them back and on-hand -1 per order.
    expect(rounds).toEqual(Array.from({ length: ROUNDS }, (_, round) => {
      const fulfilling = round % 2 === 1;
      const change = { onHand: fulfilling ? -2 : 0, allocated: 0 };
      return { results: Array(2).fill(fulfilling ? 'Pending' : 'Cancelled'), waiting: true, a: change, b: change };
    }));
  });

  // Accepted (Front desk ruling (a), 2026-09-30; ADR 0002): Vendure 3.7.3's addFulfillmentToOrder takes lines from several
  // orders in one transaction, and createSalesForOrder calls the strategy line by line (stock-movement.service.js:165), so
  // the lock, sorted within one order, is taken order by order. O1 is [A x2], O2 is [B x2]; a fulfilment of [O1.A, O2.B]
  // locks A then B, one of [O2.B, O1.A] locks B then A, and through the crossing barrier they deadlock. Postgres aborts
  // exactly one (40P01); Vendure's own retry misses it (it matches code 'deadlock_detected', transaction-wrapper.js:106),
  // so the caller retries, and the retry succeeds. No stock update is lost.
  it('multi-order deadlock: fulfilments [O1.A, O2.B] and [O2.B, O1.A] together, one aborts 40P01, its retry succeeds, stock exact', async () => {
    const [a, b] = [variantIds.print[0], variantIds.beans[0]];
    const [aId, bId] = [serviceIds.print[0], serviceIds.beans[0]];
    await setOnHand(1000, a);
    await setOnHand(1000, b);
    const [o1, o2] = [await settledShopOrder([a, a]), await settledShopOrder([b, b])];
    const sides = { AB: [o1.lineId, o2.lineId], BA: [o2.lineId, o1.lineId] };
    const before = { a: await level(aId), b: await level(bId) };
    const attempt = (lines: string[]) => fulfil(...lines).then(result => result, (error: Error) => error);
    const remove = crossingBarrier(1_000);
    let first: Array<Awaited<ReturnType<typeof attempt>>>;
    try {
      first = await Promise.all(Object.values(sides).map(attempt));
    } finally {
      remove();
    }
    const aborted = Object.keys(sides).filter((_, index) => first[index] instanceof Error);
    // The caller's retry: the aborted fulfilment again, alone.
    const retried = await Promise.all(Object.values(sides).map((lines, index) =>
      first[index] instanceof Error ? attempt(lines) : first[index]));
    const after = { a: await level(aId), b: await level(bId) };
    const change = (key: 'a' | 'b') => ({ onHand: after[key].onHand - before[key].onHand,
      allocated: after[key].allocated - before[key].allocated });
    const report = { aborted, errors: first.flatMap(result => result instanceof Error ? [result.message] : []),
      states: retried.map(result => result instanceof Error ? `error: ${result.message}` : outcome(result)),
      a: change('a'), b: change('b'), ledger: { a: await ledger(aId), b: await ledger(bId) } };
    console.log(`#62 multi-order deadlock ${JSON.stringify(report)}`);
    // Pending, not Shipped: the Sales are written on Created -> Pending, and Vendure 3.7.3 cannot ship a multi-order
    // fulfilment at all (default-fulfillment-process.js:98 runs each order's transitionToState, a savepoint, concurrently on
    // one query runner: "savepoint typeorm_3 does not exist"). Each fulfilment sells one A and one B: -2 on each.
    expect(report).toMatchObject({ aborted: [expect.stringMatching(/^(AB|BA)$/)], errors: ['deadlock detected'],
      states: ['Pending', 'Pending'], a: { onHand: -2, allocated: -2 }, b: { onHand: -2, allocated: -2 } });
    expect(report.ledger.a.movements).toEqual(report.ledger.a.level);
    expect(report.ledger.b.movements).toEqual(report.ledger.b.level);
  });
});
