import {
  Customer, PaymentMethod, ProductVariantService, RequestContextService, ShippingMethod, TransactionalConnection, User,
} from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin } from '../src';
import { tallyPaymentChecker, tallyPaymentHandler } from '../src/config/strategies';
import { TEST_HOOKS_ENV, WALK_IN_EMAIL } from '../src/service/order-create.service';
import { StoreSetupService } from '../src/service/store-setup.service';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('VP3-4a: repair the channel POS setup on demand', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, serviceIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let setup: StoreSetupService;
  let defaultChannel: { id: string; token: string };
  let second: { id: string; token: string };
  let zoneId: string;
  beforeAll(async () => {
    vi.stubEnv(TEST_HOOKS_ENV, '1');
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    setup = server.app.get(StoreSetupService);
    const { zones, activeChannel } = await adminClient.query<{
      zones: { items: Array<{ id: string; name: string }> }; activeChannel: { id: string; token: string };
    }>(parse('query { zones { items { id name } } activeChannel { id token } }'));
    defaultChannel = { id: decode(activeChannel.id), token: activeChannel.token };
    zoneId = zones.items.find(zone => zone.name === 'Denmark')!.id;
    second = await createChannel('second');
    await server.app.get(TallyPosPlugin).onApplicationBootstrap();
  });
  afterEach(() => { recipe.testHooks = {}; vi.restoreAllMocks(); });
  afterAll(async () => { vi.unstubAllEnvs(); await server.destroy(); });

  async function createChannel(name: string) {
    const { createChannel: channel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id token } } }
    `), { input: {
      code: `repair-${name}`, token: `repair-${name}-token`, defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: zoneId, defaultShippingZoneId: zoneId,
    } });
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: 'superadmin' }, relations: ['roles', 'roles.channels'],
    });
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    await server.app.get(ProductVariantService).assignProductVariantsToChannel(ctx, {
      productVariantIds: [serviceIds.mug[0]], channelId: decode(channel.id),
    });
    adminClient.setChannelToken(channel.token);
    try {
      const { createStockLocation } = await adminClient.query<{ createStockLocation: { id: string } }>(
        parse('mutation Location($name: String!) { createStockLocation(input: { name: $name }) { id } }'), { name: `repair-${name}` });
      await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) { id }
      }`), { input: [{ id: variantIds.mug[0], stockLevels: [{ stockLocationId: createStockLocation.id, stockOnHand: 20 }] }] });
    } finally {
      adminClient.setChannelToken(defaultChannel.token);
    }
    return { id: decode(channel.id), token: channel.token };
  }

  const sale = () => orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
  const shippingRows = () => connection.rawConnection.getRepository(ShippingMethod).find({
    where: { code: 'tally-in-store', deletedAt: IsNull() }, relations: ['channels'],
  });
  async function deleteShipping() {
    const [shipping] = await shippingRows();
    expect(await adminClient.query(parse('mutation Delete($id: ID!) { deleteShippingMethod(id: $id) { result } }'),
      { id: encode(shipping.id) })).toEqual({ deleteShippingMethod: { result: 'DELETED' } });
    return connection.rawConnection.getRepository(ShippingMethod).findOneByOrFail({ id: shipping.id });
  }
  async function unassignShipping() {
    const [shipping] = await shippingRows();
    await adminClient.query(parse(`mutation Remove($input: RemoveShippingMethodsFromChannelInput!) {
      removeShippingMethodsFromChannel(input: $input) { id }
    }`), { input: { shippingMethodIds: [encode(shipping.id)], channelId: encode(second.id) } });
    return shipping;
  }
  async function storeIn(channelId: string) {
    const channels = { id: channelId };
    return {
      shipping: await connection.rawConnection.getRepository(ShippingMethod).count({
        where: { code: 'tally-in-store', deletedAt: IsNull(), channels },
      }),
      payment: await connection.rawConnection.getRepository(PaymentMethod).count({ where: { code: 'tally-pos', channels } }),
      walkIn: await connection.rawConnection.getRepository(Customer).count({
        where: { emailAddress: WALK_IN_EMAIL, deletedAt: IsNull(), channels },
      }),
    };
  }

  it('1: soft-deleted shipping is recreated once and the deleted row stays deleted', async () => {
    const deleted = await deleteShipping();
    expect(deleted.deletedAt).not.toBeNull();
    expect(await run(sale(), second.token)).toMatchObject({ status: 'applied' });
    const live = await shippingRows();
    expect(live).toHaveLength(1);
    expect(String(live[0].id)).not.toBe(String(deleted.id));
    expect(live[0].channels.map(channel => String(channel.id)).sort()).toEqual([defaultChannel.id, second.id].sort());
    expect((await connection.rawConnection.getRepository(ShippingMethod).findOneByOrFail({ id: deleted.id })).deletedAt)
      .toEqual(deleted.deletedAt);
  });

  it('2: unassigned shipping is assigned again without a new row', async () => {
    const before = await connection.rawConnection.getRepository(ShippingMethod).count();
    const shipping = await unassignShipping();
    expect((await storeIn(second.id)).shipping).toBe(0);
    expect(await run(sale(), second.token)).toMatchObject({ status: 'applied' });
    expect(await connection.rawConnection.getRepository(ShippingMethod).count()).toBe(before);
    expect((await shippingRows())[0].id).toBe(shipping.id);
    expect((await storeIn(second.id)).shipping).toBe(1);
  });

  it('3: racing repairs in two channels create exactly one live shipping row', async () => {
    await deleteShipping();
    const a = sale();
    const b = sale();
    let entered!: () => void;
    let release!: () => void;
    let bInside = false;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    recipe.testHooks.insideRepair = async id => {
      if (id === a.id) entered();
      if (id === b.id) bInside = true;
      await released;
    };
    const first = run(a, second.token);
    await reached;
    const other = run(b, defaultChannel.token);
    let blocked = false;
    try {
      // A holds its uncommitted insert. Without the lock B reaches insideRepair with its own insert.
      const start = performance.now();
      while (!bInside && performance.now() - start < 3_000) {
        const waiting = await connection.rawConnection.query(`SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'
            AND query ILIKE 'SELECT pg_advisory_xact_lock%'`);
        if (waiting.length) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } finally {
      release();
    }
    const results = await Promise.all([first, other]);
    expect(results.map(result => result.status)).toEqual(['applied', 'applied']);
    expect(await shippingRows()).toHaveLength(1);
    expect(blocked).toBe(true);
  });

  it('4: repair survives a stored underpaid refusal', async () => {
    await deleteShipping();
    const input = sale();
    input.payload.payments[0].amountMinor = 1;
    const result = await run(input, second.token);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'underpaid' } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id }))
      .toMatchObject({ status: 'rejected', result });
    expect(await shippingRows()).toHaveLength(1);
  });

  it('5: a disabled payment method stays disabled and is refused unstored without repair', async () => {
    const payments = connection.rawConnection.getRepository(PaymentMethod);
    const before = await payments.find({ where: { code: 'tally-pos' } });
    await adminClient.query(parse('mutation Disable($id: ID!) { updatePaymentMethod(input: { id: $id, enabled: false }) { id } }'),
      { id: encode(before[0].id) });
    const ensure = vi.spyOn(setup, 'ensureChannelSetup');
    try {
      const input = sale();
      expect(await run(input, second.token)).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id })).toBeNull();
      expect((await payments.find({ where: { code: 'tally-pos' } })).map(method => [method.id, method.enabled]))
        .toEqual(before.map(method => [method.id, false]));
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      await adminClient.query(parse('mutation Enable($id: ID!) { updatePaymentMethod(input: { id: $id, enabled: true }) { id } }'),
        { id: encode(before[0].id) });
    }
  });

  it('6: a hard-deleted payment method is recreated with the POS handler and checker', async () => {
    const payments = connection.rawConnection.getRepository(PaymentMethod);
    const payment = await payments.findOneByOrFail({ code: 'tally-pos' });
    expect(await adminClient.query(parse('mutation Delete($id: ID!) { deletePaymentMethod(id: $id, force: true) { result } }'),
      { id: encode(payment.id) })).toEqual({ deletePaymentMethod: { result: 'DELETED' } });
    expect(await payments.count({ where: { code: 'tally-pos' } })).toBe(0);
    expect(await run(sale(), second.token)).toMatchObject({ status: 'applied' });
    const live = await payments.find({ where: { code: 'tally-pos' } });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      enabled: true, handler: { code: tallyPaymentHandler.code }, checker: { code: tallyPaymentChecker.code },
    });
  });

  it('7: the first sale configures a channel created after bootstrap', async () => {
    const third = await createChannel('third');
    expect(await storeIn(third.id)).toEqual({ shipping: 0, payment: 0, walkIn: 0 });
    expect(await run(sale(), third.token)).toMatchObject({ status: 'applied' });
    expect(await storeIn(third.id)).toEqual({ shipping: 1, payment: 1, walkIn: 1 });
    const walkIns = await connection.rawConnection.getRepository(Customer).find({
      where: { emailAddress: WALK_IN_EMAIL, deletedAt: IsNull() }, relations: ['channels'],
    });
    expect(walkIns).toHaveLength(1);
    expect(walkIns[0].channels.map(channel => String(channel.id)).sort())
      .toEqual([defaultChannel.id, second.id, third.id].sort());
  });

  it('8: an ineffective repair is tried once and returns an unstored store_configuration', async () => {
    await unassignShipping();
    // A second call fails promptly so the loop-guard mutation cannot keep repairing after the test.
    const ensure = vi.spyOn(setup, 'ensureChannelSetup')
      .mockRejectedValue(new Error('unexpected repeated repair')).mockResolvedValueOnce(undefined);
    const input = sale();
    const result = await run(input, second.token).catch(error => error);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id })).toBeNull();
  });
});
