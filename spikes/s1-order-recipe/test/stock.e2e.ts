import {
  ConfigService, Order, OrderLine, OrderService, RequestContext, RequestContextService, Sale, StockLevel,
  StockMovement, StockMovementService, TransactionalConnection, isGraphQlErrorResult,
} from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/vendored/commands';
import { createS1TestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('S1 proof 7: a stock shortage is topped up before addItemToOrder and taken back after fulfilment', () => {
  const environment = createS1TestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let url: string;
  let print: string;
  beforeAll(async () => {
    await environment.init();
    const strategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
    print = String(strategy.decodeId(variantIds.print[0]));
    connection = server.app.get(TransactionalConnection);
    url = `${await server.app.getUrl()}/tally/v1/commands`;
  });
  afterAll(() => server.destroy());

  async function submit(command: ReturnType<typeof orderCommand>) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Tally-Protocol': '1',
        Authorization: `Bearer ${adminClient.getAuthToken()}`,
      },
      body: JSON.stringify({ commands: [command] }),
    });
    const body = await response.json() as { results: CommandResult[] };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.results[0];
  }
  async function level(ctx?: RequestContext) {
    const levels = await (ctx ? connection.getRepository(ctx, StockLevel) : connection.rawConnection.getRepository(StockLevel))
      .find({ where: { productVariantId: print } });
    return { onHand: levels.reduce((sum, item) => sum + item.stockOnHand, 0),
      allocated: levels.reduce((sum, item) => sum + item.stockAllocated, 0) };
  }
  const movements = () => connection.rawConnection.getRepository(StockMovement)
    .find({ where: { productVariant: { id: print } }, order: { id: 'ASC' } });
  // Records the recipe's call order and on-hand stock inside its transaction; every spy calls Vendure unchanged.
  function observe() {
    const events: string[] = [];
    const onHand: Record<string, number> = {};
    const stock = server.app.get(StockMovementService);
    const orders = server.app.get(OrderService);
    const adjust = stock.adjustProductVariantStock.bind(stock);
    const add = orders.addItemToOrder.bind(orders);
    const transition = orders.transitionToState.bind(orders);
    const fulfil = orders.transitionFulfillmentToState.bind(orders);
    const spies = [
      vi.spyOn(stock, 'adjustProductVariantStock').mockImplementation(async (ctx, variantId, input) => {
        const before = (await level(ctx)).onHand;
        const result = await adjust(ctx, variantId, input);
        const after = (await level(ctx)).onHand;
        events.push(`adjust:${after - before}`);
        onHand[after > before ? 'afterTopUp' : 'afterTakeBack'] = after;
        return result;
      }),
      vi.spyOn(orders, 'addItemToOrder').mockImplementation(async (...args) => {
        events.push('addItemToOrder');
        return add(...args);
      }),
      vi.spyOn(orders, 'transitionToState').mockImplementation(async (...args) => {
        events.push(`order:${args[2]}`);
        return transition(...args);
      }),
      vi.spyOn(orders, 'transitionFulfillmentToState').mockImplementation(async (...args) => {
        const result = await fulfil(...args);
        events.push(`fulfilment:${args[2]}`);
        onHand.afterFulfilment = (await level(args[0])).onHand;
        return result;
      }),
    ];
    return { events, onHand, restore: () => spies.forEach(spy => spy.mockRestore()) };
  }

  it('control: without a top-up, Vendure cuts Print x3 to the saleable 2 and returns InsufficientStockError', async () => {
    const before = await level();
    const orders = server.app.get(OrderService);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    let observed: Record<string, unknown> = {};
    // A direct OrderService call without the recipe's top-up, rolled back afterwards.
    await expect(connection.withTransaction(ctx, async tx => {
      const draft = await orders.createDraft(tx);
      const single = await orders.addItemToOrder(tx, draft.id, print, 3);
      const lines = await connection.getRepository(tx, OrderLine).find({ where: { order: { id: draft.id } } });
      const other = await orders.createDraft(tx);
      const batch = await orders.addItemsToOrder(tx, other.id, [{ productVariantId: print, quantity: 3 }]);
      observed = {
        addItemToOrder: { error: isGraphQlErrorResult(single) ? single.__typename : null,
          quantityAvailable: (single as { quantityAvailable?: number }).quantityAvailable,
          savedLineQuantity: lines.map(line => line.quantity) },
        addItemsToOrder: { errors: batch.errorResults.map(error => error.__typename),
          lineQuantity: batch.order.lines.map(line => line.quantity) },
      };
      throw new Error('S1 control rollback');
    })).rejects.toThrow('S1 control rollback');
    expect(observed).toEqual({
      addItemToOrder: { error: 'InsufficientStockError', quantityAvailable: 2, savedLineQuantity: [2] },
      addItemsToOrder: { errors: ['InsufficientStockError'], lineQuantity: [2] },
    });
    expect(await level()).toEqual(before);
    console.log('S1-NUM', JSON.stringify({ proof: 7, case: 'control-no-top-up', requested: 3, stock: before, ...observed }));
  });

  it('sells Print x3 with stock 2: top-up before addItemToOrder, quantity 3, SALE -3, take-back after fulfilment', async () => {
    const before = await level();
    const lastMovement = (await movements()).at(-1)?.id ?? 0;
    const observer = observe();
    let result: CommandResult;
    const command = orderCommand([{ variantId: print, quantity: 3, unitPriceMinor: 4500 }]);
    try {
      result = await submit(command);
    } finally {
      observer.restore();
    }
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'applied', warnings: [{ code: 'insufficient_stock', variantId: print, quantity: 1 }],
    });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: result.serverRefs!.orderId }, relations: ['lines'],
    });
    expect(order.state).toBe('Delivered');
    expect(order.lines.map(line => line.quantity)).toEqual([3]);
    const events = observer.events;
    expect(events.indexOf('adjust:1')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('addItemToOrder')).toBeGreaterThan(events.indexOf('adjust:1'));
    expect(events.indexOf('order:ArrangingPayment')).toBeGreaterThan(events.indexOf('addItemToOrder'));
    expect(events.at(-1)).toBe('adjust:-1');
    expect(events.at(-2)).toBe('fulfilment:Delivered');
    const orderMovements = (await movements()).filter(movement => movement.id > lastMovement)
      .map(movement => ({ type: movement.type, quantity: movement.quantity }));
    const sales = await connection.rawConnection.getRepository(Sale).find({ where: { orderLine: { id: order.lines[0].id } } });
    expect(sales.map(sale => [sale.type, sale.quantity])).toEqual([['SALE', -3]]);
    expect(orderMovements.filter(movement => movement.type === 'SALE')).toEqual([{ type: 'SALE', quantity: -3 }]);
    const after = await level();
    expect(after).toEqual({ onHand: before.onHand - 3, allocated: before.allocated });
    const numbers = {
      proof: 7, case: 'top-up', requested: 3, before: before.onHand, ...observer.onHand, end: after.onHand,
      allocatedEnd: after.allocated, lineQuantity: order.lines[0].quantity, warnings: result.warnings,
      movements: orderMovements, events,
    };
    console.log('S1-NUM', JSON.stringify(numbers));
    expect(numbers).toMatchObject({ afterTopUp: before.onHand + 1, afterFulfilment: before.onHand + 1 - 3, end: -1 });
  });

  it('rollback: a top-up followed by an underpayment refusal leaves stock levels and movements unchanged', async () => {
    const before = { level: await level(), movements: (await movements()).length };
    const observer = observe();
    let result: CommandResult;
    try {
      result = await submit(orderCommand([{ variantId: print, quantity: 3, unitPriceMinor: 4500 }], [{ method: 'cash', amountMinor: 500 }]));
    } finally {
      observer.restore();
    }
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'ORDER_STATE_TRANSITION_ERROR' } });
    const topUp = `adjust:${3 - before.level.onHand}`;
    expect(observer.events.indexOf(topUp)).toBeGreaterThanOrEqual(0);
    expect(observer.events.indexOf('addItemToOrder')).toBeGreaterThan(observer.events.indexOf(topUp));
    const after = { level: await level(), movements: (await movements()).length };
    expect(after).toEqual(before);
    console.log('S1-NUM', JSON.stringify({ proof: 7, case: 'rollback', topUpInsideTransaction: observer.onHand.afterTopUp,
      error: result.error!.code, events: observer.events, before, after }));
  });
});
