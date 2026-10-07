import {
  Order, ProductVariantService, RequestContextService, TransactionalConnection, User,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// V2-PARITY "Per-store pricing": a store is a Vendure channel, and its prices are Vendure's per-channel variant prices; the plugin adds no price overrides.
describe('per-store pricing: each store channel sells at its own price', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let defaultToken: string;
  let northChannelId: string;

  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    const plugin = server.app.get(TallyPosPlugin);
    const { zones, activeChannel } = await adminClient.query<{
      zones: { items: Array<{ id: string; name: string }> }; activeChannel: { token: string };
    }>(parse('query { zones { items { id name } } activeChannel { token } }'));
    defaultToken = activeChannel.token;
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) {
        createChannel(input: $input) { ... on Channel { id token } ... on ErrorResult { message } }
      }`), { input: {
      code: 'store-north', token: 'store-north-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    northChannelId = decode(createChannel.id);
    await plugin.onApplicationBootstrap();
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    await server.app.get(ProductVariantService).assignProductVariantsToChannel(ctx, {
      productVariantIds: [serviceIds.mug[0]], channelId: northChannelId,
    });
    await adminClient.query(parse('mutation Untrack($id: ID!) { updateProductVariants(input: [{ id: $id, trackInventory: FALSE }]) { id } }'),
      { id: variantIds.mug[0] });
    adminClient.setChannelToken('store-north-token');
    try {
      await adminClient.query(parse(`mutation Price($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) { id price }
      }`), { input: [{ id: variantIds.mug[0], price: 1200 }] });
    } finally {
      adminClient.setChannelToken(defaultToken);
    }
  });
  afterAll(() => server.destroy());

  async function tillPrice(token?: string) {
    if (token) adminClient.setChannelToken(token);
    try {
      const { productVariant } = await adminClient.query<{
        productVariant: { price: number; priceWithTax: number; currencyCode: string };
      }>(parse('query Variant($id: ID!) { productVariant(id: $id) { price priceWithTax currencyCode } }'),
        { id: variantIds.mug[0] });
      return productVariant;
    } finally {
      adminClient.setChannelToken(defaultToken);
    }
  }

  it('the till in each store reads that store\'s price for the same variant', async () => {
    expect(await tillPrice()).toEqual({ price: 800, priceWithTax: 1000, currencyCode: 'EUR' });
    expect(await tillPrice('store-north-token')).toEqual({ price: 1200, priceWithTax: 1500, currencyCode: 'EUR' });
  });

  it('a sale in each store records that store\'s price, and neither store\'s price moves', async () => {
    const northResult = await run(orderCommand([
      { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 1200 },
    ]), 'store-north-token');
    expect(northResult).toMatchObject({ status: 'applied' });
    const defaultResult = await run(orderCommand([
      { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 },
    ]));
    expect(defaultResult).toMatchObject({ status: 'applied' });

    const orders = connection.rawConnection.getRepository(Order);
    const northOrder = await orders.findOneOrFail({
      where: { id: decode(northResult.serverRefs!.orderId) }, relations: ['lines', 'channels'],
    });
    expect(northOrder.lines).toHaveLength(1);
    expect(northOrder.lines[0]).toMatchObject({ listPrice: 1200, unitPrice: 1200 });
    expect(northOrder.channels.map(channel => String(channel.id))).toContain(northChannelId);
    const defaultOrder = await orders.findOneOrFail({
      where: { id: decode(defaultResult.serverRefs!.orderId) }, relations: ['lines', 'channels'],
    });
    expect(defaultOrder.lines).toHaveLength(1);
    expect(defaultOrder.lines[0]).toMatchObject({ listPrice: 800, unitPrice: 800 });
    expect(defaultOrder.channels.map(channel => String(channel.id))).not.toContain(northChannelId);

    expect(await tillPrice()).toMatchObject({ price: 800 });
    expect(await tillPrice('store-north-token')).toMatchObject({ price: 1200 });
  });
});
