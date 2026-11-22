import { DefaultSearchPlugin, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// 3.2a-1: versions 8, 9 and 10 are accepted for their shape only; their new fields are refused as not supported.
describe('order.create v8, v9 and v10: shape only', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin, DefaultSearchPlugin.init({})]);
  const { server, adminClient, variantIds, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());
  const sale = (version: number) => ({ ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }],
    undefined, { email: 'v10@example.com' }), version });
  const send = (command: object) => run(command as unknown as CommandEnvelope<OrderCreatePayload>);
  const stored = (id: string) => connection.rawConnection.getRepository(TallyCommand).countBy({ id });
  const payloadOf = (command: { payload: unknown }) => command.payload as Record<string, any>;
  // Refused invalid_payload, unstored, and a second send gets the same answer.
  async function expectRefused(command: ReturnType<typeof sale>, message: string) {
    for (const attempt of [1, 2]) {
      const result = await send({ ...command, attempt });
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain(message);
      expect(await stored(command.id)).toBe(0);
    }
  }

  it('(a) a v8, a v9 and a v10 sale with no new fields are each applied, each Payment under tally-pos', async () => {
    for (const version of [8, 9, 10]) {
      const result = await send(sale(version));
      expect(result.status, `v${version}`).toBe('applied');
      const { order } = await adminClient.query<{ order: { payments: { method: string }[] } }>(
        parse('query Payments($id: ID!) { order(id: $id) { payments { method } } }'), { id: result.serverRefs!.orderId });
      expect(order.payments).toEqual([{ method: 'tally-pos' }]);
    }
  });

  it('(b) a v8 sale with taxAddress is refused, unstored, naming taxAddress as not supported', async () => {
    const command = sale(8);
    payloadOf(command).taxAddress = 'billing';
    await expectRefused(command, 'taxAddress: not supported by this server');
  });

  it('a v8 sale with customer.billing or customer.shipping is refused, unstored, naming the field as not supported', async () => {
    for (const field of ['billing', 'shipping']) {
      const command = sale(8);
      payloadOf(command).customer[field] = { firstName: 'Ada', city: 'Berlin', country: 'DE' };
      await expectRefused(command, `customer.${field}: not supported by this server`);
    }
  });

  it('a v9 sale with coupons[0].lines is refused as coupons not supported, never as an unknown field', async () => {
    const command = sale(9);
    const payload = payloadOf(command);
    payload.coupons = [{ code: 'TEN', couponId: 'c1', discountMinor: 0, discountTaxMinor: 0,
      lines: [{ clientLineId: payload.lines[0].clientLineId, discountMinor: 0, discountTaxMinor: 0 }] }];
    await expectRefused(command, 'coupons: not supported by this server');
    const result = await send(command);
    expect(result.error!.message).toBe('coupons: not supported by this server');
  });

  it('(c) a v10 sale with payments[0].methodId is refused, unstored, naming payments[0].methodId', async () => {
    const command = sale(10);
    payloadOf(command).payments[0].methodId = 'card-terminal';
    await expectRefused(command, 'payments[0].methodId: not supported by this server');
  });

  it('(d) a v7 sale with payments[0].methodId is refused, naming the version it requires', async () => {
    const command = sale(7);
    payloadOf(command).payments[0].methodId = 'card-terminal';
    await expectRefused(command, 'payments[0].methodId: requires order.create version 10, command is version 7');
  });

  it('(e) a v11 sale is unsupported_version, naming 10 as the highest', async () => {
    const result = await send(sale(11));
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'unsupported_version', data: { orderCreate: 10 } } });
  });
});
