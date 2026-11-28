import { randomUUID } from 'node:crypto';
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

  it('P5: no Shop API read of a refunded POS order returns till data, anonymous or as its customer', async () => {
    const email = `${randomUUID()}@customer.example`;
    const password = 'p5-password';
    await adminClient.query(parse(`mutation Customer($email: String!, $password: String!) {
      createCustomer(input: { emailAddress: $email, firstName: "Shop", lastName: "Customer" }, password: $password) {
        ... on Customer { id } ... on ErrorResult { message }
      }
    }`), { email, password });
    expect(await shopClient.asUserWithCredentials(email, password)).toMatchObject({ identifier: email });
    const { customers } = await adminClient.query(parse(`query Customers($email: String!) {
      customers(options: { filter: { emailAddress: { eq: $email } } }) { items { id } }
    }`), { email });
    expect(customers.items).toHaveLength(1);
    const customerId: string = customers.items[0].id;

    const { activeChannel } = await adminClient.query(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `p5-${randomUUID()}`, description: 'Till refund', channelIds: [activeChannel.id],
      permissions: ['TallyPosSell', 'TallyPosRefund'] } });
    const tillEmail = `${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { emailAddress: tillEmail, password, firstName: 'Till', lastName: 'Refund', roleIds: [createRole.id] } });
    const base = await server.app.getUrl();
    const login = await fetch(`${base}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${tillEmail}", password: "${password}") { ... on CurrentUser { id } } }` }) });
    const token = login.headers.get('vendure-auth-token');
    expect(token).toBeTruthy();
    const session = { registerId: randomUUID(), sessionId: randomUUID() };
    async function post(type: string, payload: Record<string, unknown>, createdAt: string) {
      const command = { id: randomUUID(), type, version: 1, createdAt, deviceId: 'p5-till', attempt: 1, payload };
      const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ commands: [command] }) });
      expect(response.status).toBe(200);
      expect((await response.json()).results[0]).toMatchObject({ status: 'applied' });
    }
    const openedAt = new Date().toISOString();
    await post('register.session.open', { ...session, openedAt, countedFloatMinor: 0 }, openedAt);
    const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    sale.createdAt = new Date().toISOString();
    sale.payload.createdAt = sale.createdAt;
    sale.payload.customer = { customerId };
    sale.payload.cashierRef = `p5-cashier-${randomUUID()}`;
    sale.payload.registerId = session.registerId;
    sale.payload.sessionId = session.sessionId;
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const id = result.serverRefs!.orderId;
    const { order } = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) {
      code customer { id } lines { id quantity } shippingWithTax
    } }`), { id });
    expect(order.customer?.id).toBe(customerId);
    const clientRefundId = randomUUID();
    const refundCashier = `p5-refunder-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    await post('order.refund', { clientRefundId, orderId: id, ...session, cashierRef: refundCashier, createdAt,
      lines: order.lines.map((line: { id: string; quantity: number }) => ({ orderLineId: line.id, quantity: line.quantity, restock: true })),
      shippingMinor: order.shippingWithTax, adjustmentMinor: 0, destination: 'original_method', reason: 'Returned at till',
      totalMinor: sale.payload.totalMinor }, createdAt);

    const selection = `code state customFields
      customer { id emailAddress firstName lastName }
      lines { customFields productVariant { sku name } }
      surcharges { description sku }
      shippingLines { shippingMethod { code name description } }
      payments { method transactionId state metadata errorMessage refunds { method transactionId reason state metadata } }
      fulfillments { method trackingCode state }
      history { items { type data } }
      discounts { description }`;
    type ShopOrder = { code: string; customFields: unknown; lines: Array<{ customFields: unknown }>;
      payments: Array<{ refunds: Array<{ metadata: unknown }> }> };
    function assertPrivate(response: unknown, read: ShopOrder, reader: string) {
      function walk(value: unknown, path: string) {
        if (value === null || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          expect.soft(key, `${path}.${key}`).not.toMatch(/^tally/i);
          walk(child, `${path}.${key}`);
        }
      }
      walk(response, reader);
      const serialized = JSON.stringify(response);
      for (const secret of [sale.payload.cashierRef, refundCashier, session.registerId, session.sessionId, sale.payload.clientOrderId, clientRefundId]) {
        expect.soft(serialized, reader).not.toContain(secret);
      }
      const refunds = read.payments.flatMap(payment => payment.refunds);
      expect(refunds).toHaveLength(1);
      for (const refund of refunds) expect.soft(refund.metadata, reader).toEqual({});
      expect.soft(read.customFields, reader).toBeNull();
      for (const line of read.lines) expect.soft(line.customFields, reader).toBeNull();
    }
    await shopClient.asAnonymousUser();
    const anonymous = await shopClient.query<{ orderByCode: ShopOrder }>(parse(`query Order($code: String!) {
      orderByCode(code: $code) { ${selection} }
    }`), { code: order.code });
    expect(anonymous.orderByCode.code).toBe(order.code);
    assertPrivate(anonymous, anonymous.orderByCode, 'anonymous');
    expect(await shopClient.asUserWithCredentials(email, password)).toMatchObject({ identifier: email });
    const customer = await shopClient.query<{ activeCustomer: { orders: { items: ShopOrder[] } } }>(parse(`query Orders($code: String!) {
      activeCustomer { orders(options: { filter: { code: { eq: $code } } }) { items { ${selection} } } }
    }`), { code: order.code });
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    const [owned] = customer.activeCustomer.orders.items;
    expect(owned.code).toBe(order.code);
    assertPrivate(customer, owned, 'customer');

    const control = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) {
      customFields { tallyCashierRef tallyRegisterId } payments { refunds { metadata } }
    } }`), { id });
    expect(control.order.customFields).toEqual({ tallyCashierRef: sale.payload.cashierRef, tallyRegisterId: session.registerId });
    expect(control.order.payments[0].refunds[0].metadata).toMatchObject({ tallyClientRefundId: clientRefundId });
  });
});
