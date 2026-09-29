import {
  Allocation, Channel, ChannelService, GlobalSettingsService, Order, OrderService, ProductVariantService, dummyPaymentHandler,
  RequestContext, RequestContextService, StockLevel, StockLocation, StockLocationService, TransactionalConnection, User,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import { unwrap } from '../src/service/errors';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

describe('VP3-3: MultiChannel stock locations', () => {
  const environment = createPluginTestEnvironment({ paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] } });
  const { server, adminClient, shopClient, variantIds, serviceIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let ctx: RequestContext;
  let d: StockLocation;
  let x: StockLocation;
  let variantId: string;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
    ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    const locations = server.app.get(StockLocationService);
    d = await locations.defaultStockLocation(ctx);
    x = await locations.create(ctx, { name: 'X' });
    // Move D's heap tuple so the storefront control measures X3 then D2, including D's leftover allocation.
    await locations.update(ctx, { id: d.id, name: 'D renamed' });
    variantId = serviceIds.mug[0];
  });
  afterAll(() => server.destroy());
  const levels = () => connection.rawConnection.getRepository(StockLevel);
  const state = async () => Object.fromEntries((await levels().find({ where: { productVariantId: variantId } }))
    .map(level => [String(level.stockLocationId), [level.stockOnHand, level.stockAllocated]]));
  async function setLevels(onHandD: number, onHandX: number) {
    for (const [location, stockOnHand] of [[d, onHandD], [x, onHandX]] as const) {
      const existing = await levels().findOneBy({ productVariantId: variantId, stockLocationId: location.id });
      await levels().save(new StockLevel({ ...existing, productVariantId: variantId, stockLocationId: location.id,
        stockOnHand, stockAllocated: 0 }));
    }
    expect(await state()).toEqual({ [String(d.id)]: [onHandD, 0], [String(x.id)]: [onHandX, 0] });
  }
  const command = (quantity: number) => orderCommand([{ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800 }]);
  const threshold = (outOfStockThreshold: number) => server.app.get(GlobalSettingsService).updateSettings(ctx, { outOfStockThreshold });
  async function allocations(orderId: string) {
    return connection.rawConnection.getRepository(Allocation).find({ where: { orderLine: { order: { id: orderId } } } });
  }
  async function sell(quantity: number) {
    const input = command(quantity);
    const result = await run(input);
    expect(result).toMatchObject({ status: 'applied' });
    const rows = await allocations(decode(result.serverRefs!.orderId));
    const ledger = await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: input.id });
    return { result, rows, ledger };
  }

  it('1: stock only at X needs no top-up or warning', async () => {
    await setLevels(0, 5);
    const { result, rows, ledger } = await sell(3);
    expect(rows.map(row => [String(row.stockLocationId), row.quantity])).toEqual([[String(x.id), 3]]);
    expect(ledger.topUps).toBeNull();
    expect(result.warnings).toBeUndefined();
    expect(await state()).toEqual({ [String(d.id)]: [0, 0], [String(x.id)]: [2, 0] });
  });

  it('2: split shortfall tops up and takes back at D', async () => {
    await setLevels(0, 1);
    const { result, rows, ledger } = await sell(3);
    expect(ledger.topUps).toEqual([{ variantId, stockLocationId: String(d.id), quantity: 2 }]);
    expect(Object.fromEntries(rows.map(row => [String(row.stockLocationId), row.quantity])))
      .toEqual({ [String(d.id)]: 2, [String(x.id)]: 1 });
    expect(await state()).toEqual({ [String(d.id)]: [-2, 0], [String(x.id)]: [0, 0] });
    expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: variantIds.mug[0], quantity: 2 }]);
  });

  it('3: threshold under-allocation is filled and stock falls by exactly four', async () => {
    await setLevels(2, 3);
    await threshold(1);
    try {
      const { result, rows } = await sell(4);
      expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
      expect(await state()).toEqual({ [String(d.id)]: [0, 0], [String(x.id)]: [1, 0] });
      expect(result.warnings).toBeUndefined();
    } finally { await threshold(0); }
  });

  // Canary for Vendure's MultiChannel over-allocation: when upstream fixes it, this fails;
  // then update the expected storefront sum to 4 and D's leftover stockAllocated to 0.
  it('4: storefront over-allocation is measured; POS caps it without leftover allocated stock', async () => {
    await setLevels(2, 3);
    expect(String((await connection.rawConnection.getRepository(StockLocation).find())[0].id)).toBe(String(x.id));
    const methods = await createStorefrontMethods(adminClient);
    const shop = await guestOrder(shopClient, variantIds.mug[0], 'stock-locations@example.com');
    expect(shop.added.state).toBe('AddingItems');
    const added = await shopClient.query<{ addItemToOrder: { state: string } }>(parse(`mutation($id: ID!) {
      addItemToOrder(productVariantId: $id, quantity: 3) { ... on Order { state } }
    }`), { id: variantIds.mug[0] });
    expect(added.addItemToOrder.state).toBe('AddingItems');
    expect((await shop.setShipping(methods.standardShippingId)).state).toBe('AddingItems');
    expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
    const paid = await shop.pay(methods.dummyPaymentCode);
    expect(paid.state).toBe('PaymentSettled');
    const rows = await allocations(decode(paid.id!));
    const sum = rows.reduce((total, row) => total + row.quantity, 0);
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(paid.id!) }, relations: ['lines'],
    });
    const orders = server.app.get(OrderService);
    const fulfillment = unwrap(await orders.createFulfillment(ctx, {
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity })),
      handler: { code: 'manual-fulfillment', arguments: [{ name: 'method', value: 'test' }, { name: 'trackingCode', value: '' }] },
    }));
    unwrap(await orders.transitionFulfillmentToState(ctx, fulfillment.id, 'Delivered'));
    const after = await state();
    console.log(`VP3-3 storefront control: allocation sum=${sum}; D leftover stockAllocated=${after[String(d.id)][1]}`);
    expect(sum).toBe(5);
    expect(after).toEqual({ [String(d.id)]: [1, 1], [String(x.id)]: [0, 0] });
    await setLevels(2, 3);
    const pos = await sell(4);
    expect(pos.rows.reduce((total, row) => total + row.quantity, 0)).toBe(4);
    expect(await state()).toEqual({ [String(d.id)]: [1, 0], [String(x.id)]: [0, 0] });
  });

  it('two POS lines of the same variant allocate from where the stock is', async () => {
    await setLevels(2, 3);
    expect(String((await connection.rawConnection.getRepository(StockLocation).find())[0].id)).toBe(String(x.id));
    const input = orderCommand([
      { variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800 },
      { variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800 },
    ]);
    expect(input.payload.lines[0].clientLineId).not.toBe(input.payload.lines[1].clientLineId);
    const result = await run(input);
    expect(result.status).toBe('applied');
    expect(await state()).toEqual({ [String(d.id)]: [1, 0], [String(x.id)]: [0, 0] });
    const rows = await allocations(decode(result.serverRefs!.orderId));
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
    expect(rows.filter(row => String(row.stockLocationId) === String(x.id)).reduce((sum, row) => sum + row.quantity, 0)).toBe(3);
    expect(rows.filter(row => String(row.stockLocationId) === String(d.id)).reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    expect(result.warnings).toBeUndefined();
  });

  it('5: physical shortfall excludes the threshold', async () => {
    await setLevels(0, 0);
    await threshold(1);
    try {
      const { result, ledger } = await sell(2);
      expect(ledger.topUps).toEqual([{ variantId, stockLocationId: String(d.id), quantity: 3 }]);
      expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: variantIds.mug[0], quantity: 2 }]);
      expect(await state()).toEqual({ [String(d.id)]: [-2, 0], [String(x.id)]: [0, 0] });
    } finally { await threshold(0); }
  });

  it('5b: a pre-existing negative on-hand cannot warn for more than the quantity sold', async () => {
    await setLevels(-1, 0);
    const { result } = await sell(1);
    expect(result.warnings).toEqual([{ code: 'insufficient_stock', variantId: variantIds.mug[0], quantity: 1 }]);
    expect(await state()).toEqual({ [String(d.id)]: [-2, 0], [String(x.id)]: [0, 0] });
  });

  it('6: a tracked variant in a channel without stock locations is refused, unstored', async () => {
    await setLevels(0, 0);
    const defaultChannel = await connection.rawConnection.getRepository(Channel).findOneOrFail({
      where: { id: ctx.channelId }, relations: ['defaultTaxZone', 'defaultShippingZone'],
    });
    const channel = unwrap(await server.app.get(ChannelService).create(ctx, {
      code: 'no-stock-location', token: 'no-stock-location', defaultLanguageCode: ctx.channel.defaultLanguageCode,
      defaultCurrencyCode: ctx.channel.defaultCurrencyCode, pricesIncludeTax: false,
      defaultTaxZoneId: defaultChannel.defaultTaxZone.id, defaultShippingZoneId: defaultChannel.defaultShippingZone.id,
    }));
    await server.app.get(ProductVariantService).assignProductVariantsToChannel(ctx, { productVariantIds: [variantId], channelId: channel.id });
    await server.app.get(TallyPosPlugin).onApplicationBootstrap();
    expect(await connection.rawConnection.getRepository(StockLocation).count({ where: { channels: { id: channel.id } } })).toBe(0);
    const before = await state();
    const orders = await connection.rawConnection.getRepository(Order).count();
    const input = command(1);
    expect(await run(input, channel.token)).toMatchObject({ status: 'rejected', error: {
      code: 'store_configuration', message: expect.stringContaining(`Variant ${variantIds.mug[0]}`),
    } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id })).toBeNull();
    expect(await connection.rawConnection.getRepository(Order).count()).toBe(orders);
    expect(await state()).toEqual(before);
  });
});
