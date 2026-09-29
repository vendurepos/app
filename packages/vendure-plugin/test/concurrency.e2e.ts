import { RequestContext, StockLevel, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TransientCommandError } from '../src';
import type { OrderCreateResult } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// VP3-2 (Front desk rulings 5-7): the sale's stock_level rows are locked before its first stock read, and every
// wait after the claim is bounded. Without the lock, concurrent sales lost stock updates (VP3 investigation Q2).
describe('VP3-2: concurrent sales of one variant', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds, run } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let mug: string; // as commands carry it
  let mugId: string; // decoded, for repositories
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    mug = variantIds.mug[0];
    mugId = serviceIds.mug[0];
  });
  afterEach(() => { recipe.testObserver = undefined; });
  afterAll(() => server.destroy());

  let sales = 0;
  // One unit of the tracked Mug, each sale with its own new customer.
  const sale = () => orderCommand([{ variantId: mug, quantity: 1, unitPriceMinor: 800 }], undefined,
    { email: `vp3-2-${++sales}-${Date.now()}@example.com` });
  async function setOnHand(stockOnHand: number) {
    await adminClient.query(parse(`mutation SetStock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: mug, stockOnHand }] });
  }
  async function level() {
    const levels = await connection.rawConnection.getRepository(StockLevel).find({ where: { productVariantId: mugId } });
    return { onHand: levels.reduce((sum, item) => sum + item.stockOnHand, 0),
      allocated: levels.reduce((sum, item) => sum + item.stockAllocated, 0) };
  }
  const timed = async <T>(work: Promise<T>) => {
    const start = performance.now();
    const settled = await work.then(value => ({ value }), (error: unknown) => ({ error }));
    return { ...settled, ms: Math.round(performance.now() - start) } as { value?: T; error?: unknown; ms: number };
  };
  const outcome = (settled: { value?: OrderCreateResult; error?: unknown }) =>
    ({ status: settled.value?.status ?? String(settled.error), warnings: settled.value?.warnings });
  // Holds the sale's transaction (claim, order and stock lock taken, top-up written) at its first line until released.
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
  // Polls pg_stat_activity, on a pooled connection outside every sale, until a statement on stock_level waits on a lock.
  async function stockLockWait(limitMs: number) {
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      const rows = await connection.rawConnection.query(`SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%stock_level%'`);
      if (rows.length) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  it('1: a sale waits on the held sale\'s stock rows, and neither stock update is lost', async () => {
    await setOnHand(0);
    const before = await level();
    const a = sale();
    const b = sale();
    const held = hold(a);
    const first = timed(run(a));
    await held.reached;
    const second = timed(run(b));
    const blocked = await stockLockWait(3_000);
    held.release();
    const results = await Promise.all([first, second]);
    const after = await level();
    // A tops up 1 from on-hand 0 and leaves -1. B sells 1 against on-hand -1, so it tops up 2 but warns for 1:
    // the warning covers only this sale's units, not the pre-existing negative on-hand (VP3-3).
    expect({ blocked, onHand: after.onHand - before.onHand, allocated: after.allocated - before.allocated,
      results: results.map(outcome) }).toEqual({ blocked: true, onHand: -2, allocated: 0, results: [
      { status: 'applied', warnings: [{ code: 'insufficient_stock', variantId: mug, quantity: 1 }] },
      { status: 'applied', warnings: [{ code: 'insufficient_stock', variantId: mug, quantity: 1 }] },
    ] });
  });

  it('2: eight concurrent sales from on-hand 4 all apply, and on-hand ends at -4', async () => {
    await setOnHand(4);
    const before = await level();
    const results = await Promise.all(Array.from({ length: 8 }, () => timed(run(sale()))));
    const after = await level();
    expect({ onHand: after.onHand, allocated: after.allocated - before.allocated,
      statuses: results.map(result => outcome(result).status),
      warned: results.filter(result => result.value?.warnings?.some(warning => warning.code === 'insufficient_stock')).length,
    }).toEqual({ onHand: -4, allocated: 0, statuses: Array(8).fill('applied'), warned: 4 });
  });

  it('3: a sale that waits more than 5 s for the stock rows is TransientCommandError(timeout), unstored; its resend applies', async () => {
    await setOnHand(10);
    const a = sale();
    const b = sale();
    const held = hold(a);
    const first = timed(run(a));
    await held.reached;
    // A holds its stock rows for about 7 s, past B's 5 s stock lock timeout.
    const timer = setTimeout(held.release, 7_000);
    try {
      const second = await timed(run(b));
      expect(second.error).toBeInstanceOf(TransientCommandError);
      expect(second.error).toMatchObject({ commandId: b.id, kind: 'timeout', cause: { driverError: { code: '55P03' } } });
      expect(second.ms).toBeGreaterThanOrEqual(4_500);
      expect(second.ms).toBeLessThanOrEqual(7_000);
      expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: b.id })).toBeNull();
    } finally {
      clearTimeout(timer);
      held.release();
    }
    expect(outcome(await first).status).toBe('applied');
    expect(await run(b)).toMatchObject({ id: b.id, status: 'applied' });
  });

  it('4: every wait after the claim has the recipe-wide 10 s lock timeout', async () => {
    const seen: string[] = [];
    const show = async (ctx: RequestContext) =>
      (await connection.getRepository(ctx, StockLevel).query('SHOW lock_timeout') as Array<{ lock_timeout: string }>)[0].lock_timeout;
    // findVariant runs after the claim (the pre-recipe check) and after the order save (the recipe), both before the
    // stock lock, which sets 10 s again itself; so these two see what the claim and the order save left.
    type Find = { findVariant: (ctx: RequestContext, variantId: string) => Promise<unknown> };
    const findVariant = (recipe as unknown as Find).findVariant.bind(recipe);
    const spy = vi.spyOn(recipe as unknown as Find, 'findVariant').mockImplementation(async (ctx, variantId) => {
      seen.push(`findVariant:${await show(ctx)}`);
      return findVariant(ctx, variantId);
    });
    recipe.testObserver = async (stage, ctx) => {
      if (stage === 'addItemToOrder') seen.push(`addItemToOrder:${await show(ctx)}`);
    };
    try {
      expect(await run(sale())).toMatchObject({ status: 'applied' });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(['findVariant:10s', 'findVariant:10s', 'addItemToOrder:10s']);
  });
});
