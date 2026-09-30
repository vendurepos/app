import { setTimeout as sleep } from 'node:timers/promises';
import { Logger, Order, Sale, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// PLAN §1 (VP4 acceptance): one order.create sent 200 times, some concurrently and some sequentially, makes exactly one order.
describe('200-replay', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin]);
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let base: string;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    base = await server.app.getUrl();
  });
  afterAll(async () => {
    recipe.testObserver = undefined;
    await server.destroy();
  });

  async function post(body: unknown) {
    const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST', body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1',
    } });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text as any };
    }
  }

  it('PLAN §1: one order.create sent 200 times, concurrently and sequentially, makes exactly one order', async () => {
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    const errors = vi.spyOn(Logger, 'error');
    // The first send to reach addItemToOrder holds its claim for 2 s, so the other 99 race and wait on it.
    let held = 0;
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'addItemToOrder' && order.customFields.tallyClientOrderId === input.payload.clientOrderId && !held++) await sleep(2000);
    };
    let started = performance.now();
    const concurrent = await Promise.all(Array.from({ length: 100 }, () => post({ commands: [input] })));
    const concurrentMs = Math.round(performance.now() - started);
    recipe.testObserver = undefined;
    started = performance.now();
    const sequential = [];
    for (let i = 0; i < 100; i++) {
      await sleep(Math.floor(Math.random() * 51));
      sequential.push(await post({ commands: [input] }));
    }
    const sequentialMs = Math.round(performance.now() - started);
    errors.mockRestore();

    const responses = [...concurrent, ...sequential];
    const kind = (response: { status: number; body: any }) => (response.status === 200 ? response.body.results?.[0]?.status : response.status);
    const count = (value: unknown) => responses.filter(response => kind(response) === value).length;
    console.log(`200-replay: applied ${count('applied')}, duplicate ${count('duplicate')}, 409 in_progress ${count(409)};`
      + ` phase a (100 concurrent) ${concurrentMs} ms, phase b (100 sequential) ${sequentialMs} ms`);
    const unexpected = responses.filter(response => !['applied', 'duplicate', 409].includes(kind(response)));
    if (unexpected.length) console.log('unexpected responses', JSON.stringify(unexpected), 'Logger.error', JSON.stringify(errors.mock.calls));
    expect(unexpected).toEqual([]);
    expect(held).toBe(1);

    const applied = responses.filter(response => kind(response) === 'applied');
    expect(applied).toHaveLength(1);
    const result = applied[0].body.results[0];
    for (const response of responses) {
      if (response === applied[0]) continue;
      if (response.status === 409) expect(response.body).toEqual({ code: 'in_progress', id: input.id });
      else expect(response).toEqual({ status: 200, body: { results: [{ ...result, status: 'duplicate' }] } });
    }
    const orders = await connection.rawConnection.getRepository(Order).find({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    expect(orders).toHaveLength(1);
    expect(await connection.rawConnection.getRepository(TallyCommand).findBy({ id: input.id }))
      .toEqual([expect.objectContaining({ status: 'applied' })]);
    const sales = await connection.rawConnection.getRepository(Sale).find({ where: { orderLine: { order: { id: orders[0].id } } } });
    expect(sales.reduce((sum, sale) => sum + sale.quantity, 0)).toBe(-1);
  });
});
