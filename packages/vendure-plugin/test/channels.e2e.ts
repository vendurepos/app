import {
  ChannelService, ConfigService, Customer, Logger, Order, PaymentMethod, ProcessContext, ProductVariantService, RequestContextService, ShippingMethod,
  StockLevel, StockMovementService,
  TransactionalConnection, User,
} from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('store configuration in every channel, and a sale recorded in another channel', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds, decode, encode, run } = environment;
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
    expect(defaults).toEqual({ payment: 1, shipping: 1, walkIn: 1 });
    await plugin.onApplicationBootstrap();
    expect(await storeIn(second.id)).toEqual({ payment: 1, shipping: 1, walkIn: 1 });
    expect(await storeIn(defaultChannelId)).toEqual(defaults);
    // N4 ruling: one method of each, created once and assigned to both channels.
    const methods = await connection.rawConnection.getRepository(PaymentMethod).find({ where: { code: 'tally-pos' }, relations: ['channels'] });
    const shipping = await connection.rawConnection.getRepository(ShippingMethod).find({
      where: { code: 'tally-in-store', deletedAt: IsNull() }, relations: ['channels'],
    });
    for (const list of [methods, shipping]) {
      expect(list).toHaveLength(1);
      expect(list[0].channels.map(channel => String(channel.id)).sort()).toEqual([defaultChannelId, second.id].sort());
    }
  });

  it('review 10: a clientOrderId already recorded in another channel is a stored idempotency_mismatch', async () => {
    await plugin.onApplicationBootstrap();
    const mug = [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }];
    const first = orderCommand(mug);
    expect(await run(first)).toMatchObject({ status: 'applied' });
    const other = { ...first, id: orderCommand(mug).id };
    // The second channel does not sell the Mug: the collision lookup comes before the pre-claim variant
    // check (ordering ruling), so the till hears that the sale exists elsewhere, never unknown_variant.
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

  it('addendum: a variant not available in the order\'s channel is unknown_variant, stored on the claim', async () => {
    // Beans are never assigned to the second channel; Vendure's assignment makes this reachable from a till there.
    const input = orderCommand([{ variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 800 }]);
    expect(await run(input, second.token)).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'unknown_variant' } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id })).toMatchObject({ status: 'rejected' });
  });

  it('review 8: the recipe skips a deleted tally-in-store; after delete and a new bootstrap, a sale applies', async () => {
    const { shippingMethods } = await adminClient.query<{ shippingMethods: { items: Array<{ id: string; code: string }> } }>(
      parse('query { shippingMethods { items { id code } } }'));
    // Every live tally-in-store the default channel sees (the one shared with the second channel).
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

  const mugSale = () => orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);

  it('N6: a command id replayed from another channel is idempotency_mismatch, never that channel\'s refs', async () => {
    await plugin.onApplicationBootstrap();
    const input = mugSale();
    const first = await run(input);
    expect(first).toMatchObject({ status: 'applied' });
    const ledger = connection.rawConnection.getRepository(TallyCommand);
    const row = await ledger.findOneByOrFail({ id: input.id });
    expect(row.channelId).toBe(defaultChannelId);
    const orders = await connection.rawConnection.getRepository(Order).count();
    const elsewhere = await run(input, second.token);
    expect(elsewhere).toEqual({ id: input.id, status: 'rejected', error: {
      code: 'idempotency_mismatch', message: 'Command id was already used in another channel',
      data: { reason: 'command_in_other_channel' },
    } });
    expect(await ledger.findOneByOrFail({ id: input.id })).toEqual(row);
    expect(await connection.rawConnection.getRepository(Order).count()).toBe(orders);
    // The channel that owns the id still gets its own answer.
    expect(await run(input)).toEqual({ ...first, status: 'duplicate' });
  });

  it('N4: the second channel still sells after the default channel views or deletes the POS payment method', async () => {
    await plugin.onApplicationBootstrap();
    // The second channel gets the Mug, untracked because that channel has no stock location of its own.
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    await server.app.get(ProductVariantService).assignProductVariantsToChannel(ctx, {
      productVariantIds: [serviceIds.mug[0]], channelId: second.id,
    });
    await adminClient.query(parse('mutation Untrack($id: ID!) { updateProductVariants(input: [{ id: $id, trackInventory: FALSE }]) { id } }'),
      { id: variantIds.mug[0] });
    const status = async (token?: string) => (await run(mugSale(), token)).error?.code ?? 'applied';
    const methods = () => adminClient.query<{
      paymentMethods: { items: Array<{ id: string; code: string }> }; shippingMethods: { items: Array<{ id: string; code: string }> };
    }>(parse('query { paymentMethods { items { id code } } shippingMethods { items { id code } } }'));
    // Viewed: the default channel's Admin UI lists one of each, not a copy per channel.
    const { paymentMethods, shippingMethods } = await methods();
    const payment = paymentMethods.items.filter(method => method.code === 'tally-pos');
    const shipping = shippingMethods.items.filter(method => method.code === 'tally-in-store');
    expect([payment.length, shipping.length]).toEqual([1, 1]);
    expect(await status(second.token)).toBe('applied');
    const deletePayment = async () => (await adminClient.query<{ deletePaymentMethod: { result: string; message: string | null } }>(
      parse('mutation Delete($id: ID!) { deletePaymentMethod(id: $id) { result message } }'), { id: payment[0].id })).deletePaymentMethod;
    // Deleted from the default channel: Vendure refuses while another channel uses it, naming that channel.
    expect(await deletePayment()).toEqual({ result: 'NOT_DELETED', message: expect.stringContaining('vp1-second') });
    expect([await status(), await status(second.token)]).toEqual(['applied', 'applied']);
    // Deleted in the second channel: Vendure removes it from that channel only, until the next start.
    adminClient.setChannelToken(second.token);
    try {
      expect(await deletePayment()).toMatchObject({ result: 'DELETED' });
    } finally {
      adminClient.setChannelToken(ctx.channel.token);
    }
    expect([await status(), await status(second.token)]).toEqual(['applied', 'store_configuration']);
    await plugin.onApplicationBootstrap();
    expect(await status(second.token)).toBe('applied');
    expect((await storeIn(second.id)).payment).toBe(1);
  });

  it('N4: deleting the POS shipping method from any channel soft-deletes it for every channel until the next start', async () => {
    await plugin.onApplicationBootstrap();
    const status = async (token?: string) => (await run(mugSale(), token)).error?.code ?? 'applied';
    const { shippingMethods } = await adminClient.query<{ shippingMethods: { items: Array<{ id: string; code: string }> } }>(
      parse('query { shippingMethods { items { id code } } }'));
    const [shipping] = shippingMethods.items.filter(method => method.code === 'tally-in-store');
    expect(await adminClient.query(parse('mutation Delete($id: ID!) { deleteShippingMethod(id: $id) { result } }'), { id: shipping.id }))
      .toEqual({ deleteShippingMethod: { result: 'DELETED' } });
    // Vendure's ShippingMethodService.softDelete sets deletedAt on the one shared method.
    expect([await status(), await status(second.token)]).toEqual(['store_configuration', 'store_configuration']);
    await plugin.onApplicationBootstrap();
    expect([await status(), await status(second.token)]).toEqual(['applied', 'applied']);
  });

  it('review nit 3: without a usable superadmin the bootstrap logs the identifier and skips the assignment instead of failing', async () => {
    const { zones } = await adminClient.query<{ zones: { items: Array<{ id: string; name: string }> } }>(parse('query { zones { items { id name } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id } } }`), { input: {
      code: 'vp2-third', token: 'vp2-third-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    const third = decode(createChannel.id);
    // An administrator whose role lacks SuperAdmin.
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation {
      createRole(input: { code: "vp2-limited", description: "limited", permissions: [CreateOrder] }) { id } }`));
    await adminClient.query(parse(`mutation Admin($roleId: ID!) { createAdministrator(input: {
      firstName: "Limited", lastName: "Admin", emailAddress: "vp2-limited@example.com", password: "test", roleIds: [$roleId]
    }) { id } }`), { roleId: createRole.id });
    const credentials = server.app.get(ConfigService).authOptions.superadminCredentials!;
    const identifier = credentials.identifier;
    const logged = vi.spyOn(Logger, 'error');
    try {
      for (const [configured, reason] of [['vp2-nobody', 'was not found'], ['vp2-limited@example.com', 'lacks the SuperAdmin permission']]) {
        credentials.identifier = configured;
        await expect(plugin.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(`The superadmin "${configured}" (authOptions.superadminCredentials.identifier) ${reason}`),
          'TallyPosPlugin');
        // The walk-in customer needs no assignment, so it is still created.
        expect(await storeIn(third)).toEqual({ payment: 0, shipping: 0, walkIn: 1 });
      }
    } finally {
      credentials.identifier = identifier;
      logged.mockRestore();
    }
    await plugin.onApplicationBootstrap();
    expect(await storeIn(third)).toEqual({ payment: 1, shipping: 1, walkIn: 1 });
  });

  const mismatch = (id: string) => ({ id, status: 'rejected', error: {
    code: 'idempotency_mismatch', message: 'The clientOrderId is already recorded in another channel',
    data: { reason: 'client_order_in_other_channel' },
  } });

  it('N2: from the default channel, where Vendure also puts the other channel\'s order, a requeue is a stored idempotency_mismatch, never a 503', async () => {
    await plugin.onApplicationBootstrap();
    const first = mugSale();
    expect(await run(first, second.token)).toMatchObject({ status: 'applied' });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { customFields: { tallyClientOrderId: first.payload.clientOrderId } }, relations: ['channels'],
    });
    expect(order.channels.map(channel => String(channel.id)).sort()).toEqual([defaultChannelId, second.id].sort());
    const other = { ...first, id: mugSale().id };
    const result = await run(other);
    expect(result).toEqual(mismatch(other.id));
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: other.id })).toMatchObject({ status: 'rejected', result });
  });

  it('customer fix: a sale in the second channel for a default-channel customer\'s email keeps the names and adds the channel', async () => {
    const emailAddress = 'vp2-default-only@example.com';
    await adminClient.query(parse(`mutation Customer($email: String!) {
      createCustomer(input: { emailAddress: $email, firstName: "Anna", lastName: "Default" }) { ... on Customer { id } } }`), { email: emailAddress });
    const repository = connection.rawConnection.getRepository(Customer);
    const created = await repository.findOneOrFail({ where: { emailAddress }, relations: ['channels'] });
    expect(created.channels.map(channel => String(channel.id))).toEqual([defaultChannelId]);
    // The Mug is sold in the second channel since the N4 tests.
    const result = await run(orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: emailAddress }), second.token);
    expect(result).toMatchObject({ status: 'applied' });
    const customers = await repository.find({ where: { emailAddress }, relations: ['channels'] });
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: created.id, firstName: 'Anna', lastName: 'Default' });
    expect(customers[0].channels.map(channel => String(channel.id)).sort()).toEqual([defaultChannelId, second.id].sort());
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['customer'],
    });
    expect(order.customer!.id).toBe(created.id);
  });

  it('review 3: an admin resolution in the default channel takes a second-channel top-up back at that channel\'s location', async () => {
    await plugin.onApplicationBootstrap();
    const defaultToken = (await server.app.get(ChannelService).getDefaultChannel()).token;
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
    const adminCtx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    await server.app.get(ProductVariantService).assignProductVariantsToChannel(adminCtx, {
      productVariantIds: [serviceIds.print[0]], channelId: second.id,
    });
    // The second channel gets a stock location of its own, which is its default; the default channel keeps its older one.
    adminClient.setChannelToken(second.token);
    let secondLocation: string;
    try {
      ({ createStockLocation: { id: secondLocation } } = await adminClient.query<{ createStockLocation: { id: string } }>(
        parse('mutation { createStockLocation(input: { name: "vp2-second" }) { id } }')));
      await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) { updateProductVariants(input: $input) { id } }`),
        { input: [{ id: variantIds.print[0], stockLevels: [{ stockLocationId: secondLocation, stockOnHand: 1 }] }] });
    } finally {
      adminClient.setChannelToken(defaultToken);
    }
    const levels = async () => Object.fromEntries((await connection.rawConnection.getRepository(StockLevel).find({
      where: { productVariantId: serviceIds.print[0] } })).map(level => [String(level.stockLocationId), level.stockOnHand]));
    const before = await levels();
    expect(before[decode(secondLocation)]).toBe(1);
    // Print: 3 sold of 1 on hand at the second location, so 2 are topped up there, and the take-back fails.
    const stock = server.app.get(StockMovementService);
    const adjust = stock.adjustProductVariantStock.bind(stock);
    const spy = vi.spyOn(stock, 'adjustProductVariantStock').mockImplementationOnce(adjust)
      .mockImplementationOnce(() => Promise.reject(new Error('injected take-back failure')));
    const input = orderCommand([{ variantId: variantIds.print[0], quantity: 3, unitPriceMinor: 4500 }]);
    try {
      await expect(run(input, second.token)).rejects.toMatchObject({ kind: 'needs_admin' });
    } finally {
      spy.mockRestore();
    }
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: input.id })).toMatchObject({
      status: 'needs_admin', topUps: [{ variantId: serviceIds.print[0], stockLocationId: decode(secondLocation), quantity: 2 }],
    });
    const defaultCtx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    await server.app.get(OrderCreateService).resolveNeedsAdmin(defaultCtx, input.id, 'applied', 'top-up checked');
    // Per location: the second location ends at 1 - 3 (the sale without its top-up); the default location is untouched.
    expect(await levels()).toEqual({ ...before, [decode(secondLocation)]: -2 });
  });
});
