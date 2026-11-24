import { Order, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import { ORDER_CREATE_VERSIONS } from '../src/service/constants';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('the order.create versions are the plugin\'s own, not the vendored list', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  it('GET /tally/v1/info advertises order.create 1 to 5', async () => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, {
      headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contracts: { 'order.create': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], register: [1, 2, 3], 'order.refund': [1] }, taxRounding: { granularity: 'per_line_items', mode: 'half_up' },
      maxShippingLines: 1, lineTax: { none: true, classes: true }, customerDisplay: { v: 1, snapshot: 1 }, paymentMethods: [],
    });
  });

  it('/info advertises registerApproval only while the option is set (#332)', async () => {
    const info = async () => (await fetch(`${await server.app.getUrl()}/tally/v1/info`, {
      headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } })).json();
    expect(await info()).not.toHaveProperty('registerApproval');
    TallyPosPlugin.options.registerApproval = { thresholdMinor: 500 };
    try {
      expect(await info()).toMatchObject({ contracts: { register: [1, 2, 3] }, registerApproval: { thresholdMinor: 500 } });
    } finally {
      delete TallyPosPlugin.options.registerApproval;
    }
  });

  it('without init({ receiptEmail: true }), the receipt-email route answers 404 receipt_email_disabled', async () => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/orders/ANY/receipt-email`, { method: 'POST', headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } });
    expect([response.status, (await response.json()).code]).toEqual([404, 'receipt_email_disabled']);
  });

  it('a version 12 order.create is rejected as unsupported_version and writes no order', async () => {
    const counts = async () => ({
      orders: await connection.rawConnection.getRepository(Order).count(),
      commands: await connection.rawConnection.getRepository(TallyCommand).count(),
    });
    const before = await counts();
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]), version: 12 };
    const result = await run(command as unknown as CommandEnvelope<OrderCreatePayload>);
    expect(result.status).toBe('rejected');
    expect(result.error?.code).toBe('unsupported_version');
    expect(result.error?.data).toEqual({ orderCreate: 11 });
    expect(await counts()).toEqual(before);
  });

  it('ORDER_CREATE_VERSIONS is [1..11]', () => {
    expect(ORDER_CREATE_VERSIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
