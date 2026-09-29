import {
  ConfigService, Order, OrderLine, OrderService, RequestContext, RequestContextService, Sale, StockLevel,
  StockMovement, StockMovementService, TransactionalConnection, isGraphQlErrorResult,
} from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService } from '../src';
import type { OrderCreateResult } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('proof 7: a stock shortage is topped up before addItemToOrder and taken back after fulfilment', () => {
  const environment = createPluginTestEnvironment();
  const { server, variantIds, serviceIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let print: string; // as commands carry it
  let printId: string; // decoded, for repositories
  beforeAll(async () => {
    await environment.init();
    print = variantIds.print[0];
    printId = serviceIds.print[0];
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  async function level(ctx?: RequestContext) {
    const levels = await (ctx ? connection.getRepository(ctx, StockLevel) : connection.rawConnection.getRepository(StockLevel))
      .find({ where: { productVariantId: printId } });
    return { onHand: levels.reduce((sum, item) => sum + item.stockOnHand, 0),
      allocated: levels.reduce((sum, item) => sum + item.stockAllocated, 0) };
  }
  const movements = () => connection.rawConnection.getRepository(StockMovement)
    .find({ where: { productVariant: { id: printId } }, order: { id: 'ASC' } });
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
      const single = await orders.addItemToOrder(tx, draft.id, printId, 3);
      const lines = await connection.getRepository(tx, OrderLine).find({ where: { order: { id: draft.id } } });
      const other = await orders.createDraft(tx);
      const batch = await orders.addItemsToOrder(tx, other.id, [{ productVariantId: printId, quantity: 3 }]);
      observed = {
        addItemToOrder: { error: isGraphQlErrorResult(single) ? single.__typename : null,
          quantityAvailable: (single as { quantityAvailable?: number }).quantityAvailable,
          savedLineQuantity: lines.map(line => line.quantity) },
        addItemsToOrder: { errors: batch.errorResults.map(error => error.__typename),
          lineQuantity: batch.order.lines.map(line => line.quantity) },
      };
      throw new Error('control rollback');
    })).rejects.toThrow('control rollback');
    expect(observed).toEqual({
      addItemToOrder: { error: 'InsufficientStockError', quantityAvailable: 2, savedLineQuantity: [2] },
      addItemsToOrder: { errors: ['InsufficientStockError'], lineQuantity: [2] },
    });
    expect(await level()).toEqual(before);
  });

  it('sells Print x3 with stock 2: top-up before addItemToOrder, quantity 3, SALE -3, take-back after fulfilment', async () => {
    const before = await level();
    const lastMovement = (await movements()).at(-1)?.id ?? 0;
    const observer = observe();
    let result: OrderCreateResult;
    try {
      result = await run(orderCommand([{ variantId: print, quantity: 3, unitPriceMinor: 4500 }]));
    } finally {
      observer.restore();
    }
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'applied', warnings: [{ code: 'insufficient_stock', variantId: print, quantity: 1 }],
    });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines'],
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
    expect({ ...observer.onHand, end: after.onHand })
      .toMatchObject({ afterTopUp: before.onHand + 1, afterFulfilment: before.onHand + 1 - 3, end: -1 });
  });

  it('rollback: a top-up followed by an after-claim refusal (a configuration race) leaves stock levels and movements unchanged', async () => {
    const before = { level: await level(), movements: (await movements()).length };
    const observer = observe();
    const recipe = server.app.get(OrderCreateService);
    const shippingOptions = server.app.get(ConfigService).shippingOptions;
    const handlers = shippingOptions.fulfillmentHandlers;
    // Ruling (A): underpaid is now refused before the claim, so the refusal after the top-up is a race:
    // the manual fulfilment handler disappears after PaymentSettled's payment, and createFulfillment refuses.
    recipe.testObserver = async stage => {
      if (stage === 'payments') shippingOptions.fulfillmentHandlers = handlers.filter(handler => handler.code !== 'manual-fulfillment');
    };
    let result: unknown;
    try {
      result = await run(orderCommand([{ variantId: print, quantity: 3, unitPriceMinor: 4500 }])).catch((error: unknown) => error);
    } finally {
      observer.restore();
      recipe.testObserver = undefined;
      shippingOptions.fulfillmentHandlers = handlers;
    }
    // Re-ruling 3: a race after the first event rolls everything back as transient.
    expect(result).toMatchObject({ kind: 'unclassified', cause: { result: { errorCode: 'INVALID_FULFILLMENT_HANDLER_ERROR' } } });
    const topUp = `adjust:${3 - before.level.onHand}`;
    expect(observer.events.indexOf(topUp)).toBeGreaterThanOrEqual(0);
    expect(observer.events.indexOf('addItemToOrder')).toBeGreaterThan(observer.events.indexOf(topUp));
    expect({ level: await level(), movements: (await movements()).length }).toEqual(before);
  });
});
