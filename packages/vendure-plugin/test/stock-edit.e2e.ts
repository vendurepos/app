import { randomUUID } from 'node:crypto';
import { StockLevel, StockMovement, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrderCreateService } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// 10.2: POST /tally/v1/variants/:id/stock, the Products panel's stock edit as a compare-and-set on the saleable figure,
// under the same stock_level lock as a sale, so a sale between the till's read and its write is not undone.
describe('10.2: POST /tally/v1/variants/:id/stock', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let mug: string; // as the Admin API gives it
  let mugId: string; // decoded, for repositories
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    mug = variantIds.mug[0];
    mugId = serviceIds.mug[0];
  });
  afterEach(async () => {
    recipe.testObserver = undefined;
    await threshold(0);
    await setAllocated(0);
    await updateVariant({ id: mug, useGlobalOutOfStockThreshold: true, outOfStockThreshold: 0 });
  });
  afterAll(() => server.destroy());

  // receipt-email.e2e.ts's helpers.
  const call = async (path: string, body?: unknown, method = 'POST', headers: Record<string, string> = {}) => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1', ...headers } });
    return { status: response.status, body: await response.json() };
  };
  const tokenWith = async (permissions: string[]) => {
    const { activeChannel } = await adminClient.query(parse('query { activeChannel { id } }')), emailAddress = `${randomUUID()}@till.example`;
    const { createRole } = await adminClient.query(parse('mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }'),
      { input: { code: `r102-${randomUUID()}`, description: '10.2', permissions, channelIds: [activeChannel.id] } });
    await adminClient.query(parse('mutation($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }'),
      { input: { firstName: 'Till', lastName: '10.2', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const login = await fetch(`${await server.app.getUrl()}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") { ... on CurrentUser { id } } }` }) });
    return { Authorization: `Bearer ${login.headers.get('vendure-auth-token')}` };
  };

  const stock = (body: unknown, id = mug, headers?: Record<string, string>) => call(`variants/${id}/stock`, body, 'POST', headers);
  const updateVariant = (input: Record<string, unknown>) => adminClient.query(parse(`mutation Update($input: [UpdateProductVariantInput!]!) {
    updateProductVariants(input: $input) { id }
  }`), { input: [input] });
  const setOnHand = (stockOnHand: number) => updateVariant({ id: mug, stockOnHand }); // concurrency.e2e.ts's setOnHand
  // Test setup only: the route reads allocated stock, which only a storefront order's allocation would otherwise give.
  const setAllocated = (stockAllocated: number) =>
    connection.rawConnection.getRepository(StockLevel).update({ productVariantId: mugId }, { stockAllocated });
  const threshold = (outOfStockThreshold: number) => adminClient.query(parse(`mutation Settings($input: UpdateGlobalSettingsInput!) {
    updateGlobalSettings(input: $input) { ... on GlobalSettings { id } }
  }`), { input: { outOfStockThreshold } });
  const level = () => connection.rawConnection.getRepository(StockLevel).findOneByOrFail({ productVariantId: mugId });
  const adjustments = () => connection.rawConnection.getRepository(StockMovement).find({
    where: { productVariant: { id: mugId }, type: 'ADJUSTMENT' as never }, order: { id: 'ASC' } });
  // The saleable figure as the till reads it, with the global threshold at 0 (afterEach's).
  const saleableNow = async () => { const { stockOnHand, stockAllocated } = await level(); return Math.max(stockOnHand - stockAllocated, 0); };
  let sales = 0;
  const sale = () => orderCommand([{ variantId: mug, quantity: 1, unitPriceMinor: 800 }], undefined,
    { email: `s102-${++sales}-${Date.now()}@example.com` });
  const sell = (command = sale()) => call('commands', { commands: [command] });

  it('1: writes the saleable figure, one adjustment of the difference', async () => {
    await setOnHand(10);
    const before = (await adjustments()).length;
    expect(await stock({ expectedSaleable: 10, saleable: 7 })).toEqual({ status: 200, body: { saleable: 7, stockOnHand: 7 } });
    const after = await adjustments();
    expect({ added: after.length - before, quantity: after.at(-1)?.quantity, onHand: (await level()).stockOnHand })
      .toEqual({ added: 1, quantity: -3, onHand: 7 });
  });

  it('2: a sale between the till\'s read and its write is refused stock_changed, nothing written', async () => {
    await setOnHand(10);
    const s = await saleableNow();
    expect((await sell()).body.results[0]).toMatchObject({ status: 'applied' });
    const onHand = (await level()).stockOnHand, before = (await adjustments()).length;
    expect(await stock({ expectedSaleable: s, saleable: 20 })).toMatchObject({ status: 409, body: { code: 'stock_changed', saleable: s - 1 } });
    expect({ onHand: (await level()).stockOnHand, added: (await adjustments()).length - before }).toEqual({ onHand, added: 0 });
  });

  it('3: a sale in flight holds the lock; the edit waits for it and sees its figure', async () => {
    await setOnHand(10);
    const s = await saleableNow(), command = sale(), events: string[] = [];
    let paused!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { paused = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'payments' && order.customFields.tallyClientOrderId === command.payload.clientOrderId) {
        events.push('sale-paused');
        paused();
        await released;
      }
    };
    const sold = sell(command);
    await reached;
    const routed = stock({ expectedSaleable: s, saleable: 20 }).then(answer => (events.push('route-answered'), answer));
    let waiting = false;
    for (const start = performance.now(); !waiting && performance.now() - start < 3_000;) {
      const [{ n }] = await connection.rawConnection.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`);
      waiting = n > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 50));
    }
    events.push('released');
    release();
    const [saleAnswer, answer] = await Promise.all([sold, routed]);
    expect(waiting).toBe(true);
    expect(saleAnswer.body.results[0]).toMatchObject({ status: 'applied' });
    expect(events).toEqual(['sale-paused', 'released', 'route-answered']);
    expect(answer).toMatchObject({ status: 409, body: { code: 'stock_changed', saleable: s - 1 } });
  });

  it('4: allocated stock and the threshold, global then the variant\'s own', async () => {
    await setOnHand(10);
    await setAllocated(2);
    await threshold(1);
    expect(await stock({ expectedSaleable: 7, saleable: 4 })).toEqual({ status: 200, body: { saleable: 4, stockOnHand: 7 } });
    expect((await level()).stockOnHand).toBe(7);
    await setOnHand(10);
    await updateVariant({ id: mug, useGlobalOutOfStockThreshold: false, outOfStockThreshold: 3 });
    const before = (await adjustments()).length;
    expect(await stock({ expectedSaleable: 5, saleable: 5 })).toEqual({ status: 200, body: { saleable: 5, stockOnHand: 10 } });
    expect((await adjustments()).length - before).toBe(0);
  });

  it('5: oversold, the current figure clamps to 0, and the write keeps the allocation', async () => {
    await setOnHand(1);
    await setAllocated(2);
    const before = (await adjustments()).length;
    expect(await stock({ expectedSaleable: 0, saleable: 5 })).toEqual({ status: 200, body: { saleable: 5, stockOnHand: 7 } });
    expect({ onHand: (await level()).stockOnHand, added: (await adjustments()).length - before }).toEqual({ onHand: 7, added: 1 });
  });

  it('6: a resend after a lost answer is refused stock_changed and writes nothing more', async () => {
    await setOnHand(10);
    const s = await saleableNow(), before = (await adjustments()).length;
    expect(await stock({ expectedSaleable: s, saleable: s + 2 })).toMatchObject({ status: 200 });
    expect(await stock({ expectedSaleable: s, saleable: s + 2 })).toMatchObject({ status: 409, body: { code: 'stock_changed', saleable: s + 2 } });
    expect((await adjustments()).length - before).toBe(1);
  });

  it('7: refusals: a bad body, an unknown variant, a till-only user and a variant at two stock locations', async () => {
    await setOnHand(10);
    const before = (await adjustments()).length;
    for (const body of [{ expectedSaleable: 10, saleable: 7, extra: 1 }, { expectedSaleable: 10, saleable: -1 },
      { expectedSaleable: 10, saleable: 1.5 }, { saleable: 7 }]) {
      expect(await stock(body), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
    }
    for (const id of ['not-an-id', 'T_999999']) {
      expect(await stock({ expectedSaleable: 10, saleable: 7 }, id), id).toMatchObject({ status: 404, body: { code: 'variant_not_found' } });
    }
    expect((await stock({ expectedSaleable: 10, saleable: 7 }, mug, await tokenWith(['TallyPosSell']))).status).toBe(403);
    expect({ onHand: (await level()).stockOnHand, added: (await adjustments()).length - before }).toEqual({ onHand: 10, added: 0 });

    const { stockLocations } = await adminClient.query(parse('query { stockLocations { items { id } } }'));
    const { createStockLocation } = await adminClient.query(parse('mutation { createStockLocation(input: { name: "s102-second" }) { id } }'));
    await updateVariant({ id: variantIds.print[0], stockLevels: [
      { stockLocationId: stockLocations.items[0].id, stockOnHand: 2 }, { stockLocationId: createStockLocation.id, stockOnHand: 1 }] });
    expect(await stock({ expectedSaleable: 2, saleable: 3 }, variantIds.print[0]))
      .toMatchObject({ status: 409, body: { code: 'stock_level_not_single' } });
  });
});
