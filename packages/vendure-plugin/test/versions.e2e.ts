import { Order, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyCommand } from '../src';
import { ORDER_CREATE_VERSIONS } from '../src/service/constants';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../src/vendored/versions';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// A re-vendored versions.ts from a TallyUI core that already lists v5.
vi.mock('../src/vendored/versions', () => ({
  SUPPORTED_ORDER_CREATE_VERSIONS: [1, 2, 3, 4, 5],
  SUPPORTED_REGISTER_VERSIONS: [1],
}));

describe('the order.create versions are the plugin\'s own, not the vendored list', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  it('the vendored list is mocked to include v5', () => {
    expect(SUPPORTED_ORDER_CREATE_VERSIONS).toEqual([1, 2, 3, 4, 5]);
  });

  it('GET /tally/v1/info still advertises order.create 1, 2, 3 and 4 only', async () => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, {
      headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contracts: { 'order.create': [1, 2, 3, 4], register: [1] }, taxRounding: { granularity: 'per_line_items', mode: 'half_up' },
      maxShippingLines: 1, lineTax: { none: true, classes: true },
    });
  });

  it('a version 6 order.create is rejected as unsupported_version and writes no order', async () => {
    const counts = async () => ({
      orders: await connection.rawConnection.getRepository(Order).count(),
      commands: await connection.rawConnection.getRepository(TallyCommand).count(),
    });
    const before = await counts();
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]), version: 6 };
    const result = await run(command as unknown as CommandEnvelope<OrderCreatePayload>);
    expect(result.status).toBe('rejected');
    expect(result.error?.code).toBe('unsupported_version');
    expect(result.error?.data).toEqual({ orderCreate: 5 });
    expect(await counts()).toEqual(before);
  });

  it('ORDER_CREATE_VERSIONS is [1, 2, 3, 4, 5]', () => {
    expect(ORDER_CREATE_VERSIONS).toEqual([1, 2, 3, 4, 5]);
  });
});
