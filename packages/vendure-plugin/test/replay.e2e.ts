import { setTimeout as sleep } from 'node:timers/promises';
import { Logger, Order, Payment, Sale, StockLevel, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// PLAN §1 (VP4 acceptance): one order.create sent 200 times, some concurrently and some sequentially, makes exactly one order.
describe('200-replay', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin]);
  const { server, adminClient, variantIds, serviceIds } = environment;
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
    // The first send to reach addItemToOrder holds its claim for 2 s, so the other 109 race and wait on it.
    let held = 0;
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'addItemToOrder' && order.customFields.tallyClientOrderId === input.payload.clientOrderId && !held++) await sleep(2000);
    };
    const stock = async () => (await connection.rawConnection.getRepository(StockLevel).findBy({ productVariantId: serviceIds.mug[0] }))
      .reduce((sum, level) => ({ onHand: sum.onHand + level.stockOnHand, allocated: sum.allocated + level.stockAllocated }),
        { onHand: 0, allocated: 0 });
    const stockBefore = await stock();
    // Review #34: 10 sends of the same sale under a new command id each, one after every 10 same-id sends.
    const newIds = Array.from({ length: 10 }, () => ({ ...input, id: orderCommand([]).id }));
    let started = performance.now();
    const sends = await Promise.all(Array.from({ length: 110 }, (_, i) => {
      const command = i % 11 === 10 ? newIds[(i - 10) / 11] : input;
      return post({ commands: [command] }).then(response => ({ command, response }));
    }));
    const concurrent = sends.filter(send => send.command === input).map(send => send.response);
    const concurrentMs = Math.round(performance.now() - started);
    recipe.testObserver = undefined;
    started = performance.now();
    const sequential = [];
    for (let i = 0; i < 100; i++) {
      await sleep(Math.floor(Math.random() * 51));
      sequential.push(await post({ commands: [input] }));
    }
    const sequentialMs = Math.round(performance.now() - started);
    // Each new id resent once: one the collision guard stored replays as duplicate.
    const resent = [];
    for (const command of newIds) resent.push({ command, response: await post({ commands: [command] }) });
    const fresh = [...sends.filter(send => send.command !== input), ...resent];
    errors.mockRestore();

    const responses = [...concurrent, ...sequential];
    const kind = (response: { status: number; body: any }) => (response.status === 200 ? response.body.results?.[0]?.status : response.status);
    const count = (value: unknown) => responses.filter(response => kind(response) === value).length;
    const freshCount = (value: unknown) => fresh.filter(send => kind(send.response) === value).length;
    console.log(`200-replay: applied ${count('applied')}, duplicate ${count('duplicate')}, 409 in_progress ${count(409)};`
      + ` new ids: applied ${freshCount('applied')}, duplicate ${freshCount('duplicate')}, 409 in_progress ${freshCount(409)};`
      + ` phase a (100 concurrent + 10 new ids) ${concurrentMs} ms, phase b (100 sequential) ${sequentialMs} ms`);
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
    // A new id waits on the first sale (409), or the collision guard stores it as applied with the first sale's refs.
    const freshUnexpected = fresh.filter(send => !['applied', 'duplicate', 409].includes(kind(send.response)));
    if (freshUnexpected.length) console.log('unexpected new-id responses', JSON.stringify(freshUnexpected));
    expect(freshUnexpected).toEqual([]);
    for (const { command, response } of fresh) {
      if (response.status === 409) expect(response.body).toEqual({ code: 'in_progress', id: command.id });
      else expect(response.body).toEqual({ results: [{ ...result, id: command.id, status: kind(response) }] });
    }
    for (let i = 0; i < 10; i++) if (kind(fresh[i].response) === 'applied') expect(kind(resent[i].response)).toBe('duplicate');
    // The first sale's command and the 10 new ids, all stored as applied (the 409 ones by their resend).
    expect((await connection.rawConnection.getRepository(TallyCommand).findBy({ clientOrderId: input.payload.clientOrderId }))
      .map(row => row.status)).toEqual(Array(11).fill('applied'));
    const orders = await connection.rawConnection.getRepository(Order).find({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    expect(orders).toHaveLength(1);
    expect(await connection.rawConnection.getRepository(TallyCommand).findBy({ id: input.id }))
      .toEqual([expect.objectContaining({ status: 'applied' })]);
    const sales = await connection.rawConnection.getRepository(Sale).find({ where: { orderLine: { order: { id: orders[0].id } } } });
    expect(sales.reduce((sum, sale) => sum + sale.quantity, 0)).toBe(-1);
    const payments = await connection.rawConnection.getRepository(Payment).findBy({ order: { id: orders[0].id } });
    // The sale's total: the 800 Mug plus 25% tax, 1000.
    expect(payments.map(payment => [payment.state, payment.amount])).toEqual([['Settled', input.payload.totalMinor]]);
    expect(await stock()).toEqual({ onHand: stockBefore.onHand - 1, allocated: stockBefore.allocated });
  });
});
