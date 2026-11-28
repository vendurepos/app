import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderCustomFields, orderLineCustomFields } from '../src/config/custom-fields';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('POS order custom field visibility', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, shopClient, variantIds, run } = environment;
  let orderId: string;
  let code: string;
  let clientOrderId: string;

  beforeAll(() => environment.init());
  afterAll(() => server.destroy());

  it('P1: every tally order and order-line field is private', () => {
    expect(orderCustomFields).toHaveLength(10);
    expect(orderLineCustomFields).toHaveLength(5);
    for (const field of [...orderCustomFields, ...orderLineCustomFields]) {
      expect(field.name).toMatch(/^tally/);
      expect(field.public).toBe(false);
    }
  });

  it('P2: an anonymous shopper can read a fresh POS order but not its custom fields', async () => {
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    command.createdAt = new Date().toISOString();
    command.payload.createdAt = command.createdAt;
    clientOrderId = command.payload.clientOrderId;
    const result = await run(command);
    expect(result.status).toBe('applied');
    orderId = result.serverRefs!.orderId;
    const { order } = await adminClient.query<{ order: { code: string } }>(
      parse('query Order($id: ID!) { order(id: $id) { code } }'), { id: orderId });
    code = order.code;

    await shopClient.asAnonymousUser();
    const { orderByCode } = await shopClient.query(parse(`query Order($code: String!) {
      orderByCode(code: $code) { code customFields lines { customFields } }
    }`), { code });
    expect(orderByCode.code).toBe(code);
    expect(orderByCode.customFields).toBeNull();
    expect(orderByCode.lines).toHaveLength(1);
    for (const line of orderByCode.lines) expect(line.customFields).toBeNull();
  });

  it('P3: the Shop API rejects a tallySnapshot selection', async () => {
    await expect(shopClient.query(parse(`query Order($code: String!) {
      orderByCode(code: $code) { customFields { tallySnapshot } }
    }`), { code })).rejects.toThrow(/tallySnapshot|must not have a selection/);
  });

  it('P4: the Admin API can still select all tally fields', async () => {
    const { order } = await adminClient.query(parse(`query Order($id: ID!) {
      order(id: $id) {
        customFields { tallyClientOrderId tallySaleAt tallyRegisterId tallySessionId tallyCashierRef
          tallyPayments tallyShipping tallySnapshot tallyRejectedClientOrderId tallyRejected }
        lines { customFields { tallyUnitPrice tallyClientLineId tallyPriceIncludesTax tallyCustomName tallyCustomSku } }
      }
    }`), { id: orderId });
    expect(order.customFields.tallyClientOrderId).toBe(clientOrderId);
    expect(order.customFields.tallySnapshot).toBeTypeOf('string');
    expect(() => JSON.parse(order.customFields.tallySnapshot)).not.toThrow();
    expect(order.lines[0].customFields.tallyUnitPrice).toBe(800);
  });
});
