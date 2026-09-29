import { Customer, Order, PaymentMethod, ProcessContext, ShippingMethod, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('store configuration in every channel, and a sale recorded in another channel', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  let plugin: TallyPosPlugin;
  let defaultChannelId: string;
  let second: { id: string; token: string };
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    plugin = server.app.get(TallyPosPlugin);
    const { zones, activeChannel } = await adminClient.query<{
      zones: { items: Array<{ id: string; name: string }> }; activeChannel: { id: string };
    }>(parse('query { zones { items { id name } } activeChannel { id } }'));
    defaultChannelId = decode(activeChannel.id);
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) {
        createChannel(input: $input) { ... on Channel { id token } ... on ErrorResult { message } }
      }`), { input: {
      code: 'vp1-second', token: 'vp1-second-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    second = { id: decode(createChannel.id), token: createChannel.token };
  });
  afterAll(() => server.destroy());

  async function storeIn(channelId: string) {
    const inChannel = { channels: { id: channelId } };
    return {
      payment: await connection.rawConnection.getRepository(PaymentMethod).count({ where: { code: 'tally-pos', ...inChannel } }),
      shipping: await connection.rawConnection.getRepository(ShippingMethod).count({
        where: { code: 'tally-in-store', deletedAt: IsNull(), ...inChannel },
      }),
      walkIn: await connection.rawConnection.getRepository(Customer).count({
        where: { emailAddress: 'walk-in@vendurepos.invalid', ...inChannel },
      }),
    };
  }

  it('review 9: the server-process bootstrap gives every channel the POS methods and the walk-in customer, once', async () => {
    // The channel was created after start-up, so only a new bootstrap can configure it.
    expect(await storeIn(second.id)).toEqual({ payment: 0, shipping: 0, walkIn: 0 });
    const isServer = vi.spyOn(server.app.get(ProcessContext), 'isServer', 'get').mockReturnValue(false);
    try {
      await plugin.onApplicationBootstrap();
      expect(await storeIn(second.id)).toEqual({ payment: 0, shipping: 0, walkIn: 0 });
    } finally {
      isServer.mockRestore();
    }
    await plugin.onApplicationBootstrap();
    expect(await storeIn(second.id)).toEqual({ payment: 1, shipping: 1, walkIn: 1 });
    const defaults = await storeIn(defaultChannelId);
    expect(defaults.walkIn).toBe(1);
    await plugin.onApplicationBootstrap();
    expect(await storeIn(second.id)).toEqual({ payment: 1, shipping: 1, walkIn: 1 });
    expect(await storeIn(defaultChannelId)).toEqual(defaults);
  });

  it('review 10: a clientOrderId already recorded in another channel is a stored idempotency_mismatch', async () => {
    await plugin.onApplicationBootstrap();
    const mug = [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }];
    const first = orderCommand(mug);
    expect(await run(first)).toMatchObject({ status: 'applied' });
    const other = { ...first, id: orderCommand(mug).id };
    const orders = await connection.rawConnection.getRepository(Order).count();
    const result = await run(other, second.token);
    expect(result).toEqual({ id: other.id, status: 'rejected', error: {
      code: 'idempotency_mismatch', message: 'The clientOrderId is already recorded in another channel',
      data: { reason: 'client_order_in_other_channel' },
    } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: other.id }))
      .toMatchObject({ status: 'rejected', result });
    expect(await run(other, second.token)).toEqual(result);
    expect(await connection.rawConnection.getRepository(Order).count()).toBe(orders);
  });

  it('review 8: the recipe skips a deleted tally-in-store; after delete and a new bootstrap, a sale applies', async () => {
    const { shippingMethods } = await adminClient.query<{ shippingMethods: { items: Array<{ id: string; code: string }> } }>(
      parse('query { shippingMethods { items { id code } } }'));
    // Every live tally-in-store the default channel sees (its own, and the second channel's copy).
    const deleted = shippingMethods.items.filter(method => method.code === 'tally-in-store').map(method => decode(method.id));
    expect(deleted.length).toBeGreaterThan(0);
    for (const id of deleted) {
      await adminClient.query(parse('mutation Delete($id: ID!) { deleteShippingMethod(id: $id) { result } }'), { id: encode(id) });
    }
    expect((await storeIn(defaultChannelId)).shipping).toBe(0);
    await plugin.onApplicationBootstrap();
    const result = await run(orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['shippingLines', 'shippingLines.shippingMethod'],
    });
    expect(order.shippingLines.map(line => line.shippingMethod.code)).toEqual(['tally-in-store']);
    expect(deleted).not.toContain(String(order.shippingLines[0].shippingMethod.id));
  });
});
