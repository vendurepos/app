import { randomUUID } from 'node:crypto';
import { ConfigService, Order, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { OrderHistoryEntry } from '@vendure/core/dist/entity/history-entry/order-history-entry.entity';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import { SHOP_CANCEL_REASON, SHOP_REFUND_REASON } from '../src/api/shop-api';
import { orderCustomFields, orderLineCustomFields } from '../src/config/custom-fields';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

describe('POS order custom field visibility', () => {
  const environment = createPluginTestEnvironment({ paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] } });
  const { server, adminClient, shopClient, variantIds, run } = environment;
  let orderId: string;
  let code: string;
  let clientOrderId: string;

  let till: Awaited<ReturnType<typeof setupTill>>;
  beforeAll(async () => {
    await environment.init();
    till = await setupTill();
  });
  afterAll(() => server.destroy());

  it('P1: every tally order and order-line field is private', () => {
    expect(orderCustomFields).toHaveLength(10);
    expect(orderLineCustomFields).toHaveLength(5);
    for (const field of [...orderCustomFields, ...orderLineCustomFields]) {
      expect(field.name).toMatch(/^tally/);
      expect(field.public).toBe(false);
    }
    const counts: Record<string, number> = {};
    for (const [entity, fields] of Object.entries(server.app.get(ConfigService).customFields)) {
      for (const field of fields.filter(field => /^tally/i.test(field.name))) {
        expect(field.public, `${entity}.${field.name}`).toBe(false);
        counts[entity] = (counts[entity] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({ Order: 10, OrderLine: 5 });
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

  async function setupTill() {
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
    return { email, password, customerId, session, post };
  }

  function freshSale() {
    const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    sale.createdAt = new Date().toISOString();
    sale.payload.createdAt = sale.createdAt;
    sale.payload.cashierRef = `p5-cashier-${randomUUID()}`;
    Object.assign(sale.payload, till.session);
    return sale;
  }

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
    payments: Array<{ refunds: Array<{ metadata: unknown; reason: string }> }>;
    history: { items: Array<{ type: string; data: Record<string, unknown> }> } };

  async function anonymousRead(code: string) {
    await shopClient.asAnonymousUser();
    return shopClient.query<{ orderByCode: ShopOrder }>(parse(`query Order($code: String!) {
      orderByCode(code: $code) { ${selection} }
    }`), { code });
  }

  async function customerRead(code: string) {
    const { email, password } = till;
    expect(await shopClient.asUserWithCredentials(email, password)).toMatchObject({ identifier: email });
    return shopClient.query<{ activeCustomer: { orders: { items: ShopOrder[] } } }>(parse(`query Orders($code: String!) {
      activeCustomer { orders(options: { filter: { code: { eq: $code } } }) { items { ${selection} } } }
    }`), { code });
  }

  it('P5: no Shop API read of a refunded POS order returns till data, anonymous or as its customer', async () => {
    const { customerId, session, post } = till;
    const sale = freshSale();
    delete sale.payload.customer;
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const id = result.serverRefs!.orderId;
    const customerNote = `p5-customer-note-${randomUUID()}`;
    await adminClient.query(parse(`mutation Customer($input: SetOrderCustomerInput!) {
      setOrderCustomer(input: $input) { id }
    }`), { input: { orderId: id, customerId, note: customerNote } });
    const { order } = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) {
      code customer { id } lines { id quantity } shippingWithTax
    } }`), { id });
    expect(order.customer?.id).toBe(customerId);
    const clientRefundId = randomUUID();
    const refundCashier = `p5-refunder-${randomUUID()}`;
    const reason = `p5-reason-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    await post('order.refund', { clientRefundId, orderId: id, ...session, cashierRef: refundCashier, createdAt,
      lines: order.lines.map((line: { id: string; quantity: number }) => ({ orderLineId: line.id, quantity: line.quantity, restock: true })),
      shippingMinor: order.shippingWithTax, adjustmentMinor: 0, destination: 'original_method', reason,
      totalMinor: sale.payload.totalMinor }, createdAt);

    const privateNote = `p5-private-note-${randomUUID()}`;
    await adminClient.query(parse(`mutation Note($input: AddNoteToOrderInput!) { addNoteToOrder(input: $input) { id } }`),
      { input: { id, note: privateNote, isPublic: false } });
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
      for (const secret of [sale.payload.cashierRef, refundCashier, session.registerId, session.sessionId, sale.payload.clientOrderId,
        clientRefundId, reason, customerNote, privateNote]) {
        expect.soft(serialized, reader).not.toContain(secret);
      }
      const refunds = read.payments.flatMap(payment => payment.refunds);
      expect(refunds).toHaveLength(1);
      for (const refund of refunds) {
        expect.soft(refund.metadata, reader).toEqual({});
        expect.soft(refund.reason, reader).toBe(SHOP_REFUND_REASON);
      }
      const transitions = read.history.items.filter(entry => entry.type === 'ORDER_REFUND_TRANSITION');
      expect(transitions.length).toBeGreaterThan(0);
      for (const entry of transitions) expect.soft(entry.data.reason, reader).toBe(SHOP_REFUND_REASON);
      const changes = read.history.items.filter(entry => entry.type === 'ORDER_CUSTOMER_UPDATED');
      expect(changes.length).toBeGreaterThan(0);
      for (const entry of changes) expect.soft(entry.data, reader).not.toHaveProperty('note');
      expect.soft(read.customFields, reader).toBeNull();
      for (const line of read.lines) expect.soft(line.customFields, reader).toBeNull();
    }
    const anonymous = await anonymousRead(order.code);
    expect(anonymous.orderByCode.code).toBe(order.code);
    assertPrivate(anonymous, anonymous.orderByCode, 'anonymous');
    const customer = await customerRead(order.code);
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    const [owned] = customer.activeCustomer.orders.items;
    expect(owned.code).toBe(order.code);
    assertPrivate(customer, owned, 'customer');

    const control = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) {
      customFields { tallyCashierRef tallyRegisterId } payments { refunds { metadata reason } } history { items { type data isPublic } }
    } }`), { id });
    expect(control.order.customFields).toEqual({ tallyCashierRef: sale.payload.cashierRef, tallyRegisterId: session.registerId });
    expect(control.order.payments[0].refunds[0].metadata).toMatchObject({ tallyClientRefundId: clientRefundId });
    expect(control.order.payments[0].refunds[0].reason).toBe(reason);
    expect(control.order.history.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ORDER_REFUND_TRANSITION', data: expect.objectContaining({ reason }) }),
      expect.objectContaining({ type: 'ORDER_CUSTOMER_UPDATED', data: expect.objectContaining({ note: customerNote }) }),
      expect.objectContaining({ type: 'ORDER_NOTE', isPublic: false, data: { note: privateNote } }),
    ]));
  });

  it('P6: both Shop readers see a neutral rejection reason, including for legacy cancellations', async () => {
    const sale = freshSale();
    sale.payload.customer = { customerId: till.customerId };
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const { orderId: id, displayId: code } = result.serverRefs!;
    expect(code).toEqual(expect.any(String));
    if (!code) throw new Error('no displayId');
    const db = server.app.get(TransactionalConnection).rawConnection;
    await db.getRepository(TallyCommand).update({ id: sale.id }, { status: 'needs_admin' });
    const note = `p6-admin-note-${randomUUID()}`;
    const { tallyResolveNeedsAdmin } = await adminClient.query(parse(`mutation Reject($commandId: String!, $note: String!) {
      tallyResolveNeedsAdmin(commandId: $commandId, resolution: rejected, note: $note) { id status }
    }`), { commandId: sale.id, note });
    expect(tallyResolveNeedsAdmin).toEqual({ id: sale.id, status: 'rejected' });

    function assertCancelled(response: unknown, order: ShopOrder, secret: string) {
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(order.code).toBe(code);
      expect(order.history.items).toContainEqual(expect.objectContaining({ type: 'ORDER_CANCELLATION',
        data: expect.objectContaining({ reason: SHOP_CANCEL_REASON }) }));
    }
    const anonymous = await anonymousRead(code);
    assertCancelled(anonymous, anonymous.orderByCode, note);
    const customer = await customerRead(code);
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    assertCancelled(customer, customer.activeCustomer.orders.items[0], note);

    const { order } = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) { history { items { id type isPublic data } } } }`), { id });
    expect(order.history.items).toContainEqual(expect.objectContaining({ type: 'ORDER_NOTE', isPublic: false,
      data: { note: expect.stringContaining(note) } }));
    const cancellation = order.history.items.find((entry: { type: string }) => entry.type === 'ORDER_CANCELLATION');
    expect(cancellation.data.reason).toBe(SHOP_CANCEL_REASON);
    const legacy = `p6-legacy-${randomUUID()}`;
    const updated = await db.getRepository(OrderHistoryEntry).update(environment.decode(cancellation.id), { data: { ...cancellation.data, reason: legacy } });
    expect(updated.affected).toBe(1);
    const reread = await anonymousRead(code);
    assertCancelled(reread, reread.orderByCode, legacy);
  });

  async function adminRefundAndCancel(orderId: string, refundReason: string, cancelReason: string, amount?: number) {
    const { order } = await adminClient.query(parse(`query Order($id: ID!) {
      order(id: $id) { payments { id amount } }
    }`), { id: orderId });
    const [payment] = order.payments;
    const { refundOrder } = await adminClient.query(parse(`mutation Refund($input: RefundOrderInput!) {
      refundOrder(input: $input) { __typename ... on Refund { id total state } ... on ErrorResult { errorCode message } }
    }`), { input: { paymentId: payment.id, amount: amount ?? payment.amount, shipping: 0, adjustment: 0, reason: refundReason } });
    expect(refundOrder).toMatchObject({ __typename: 'Refund' });
    const { cancelOrder } = await adminClient.query(parse(`mutation Cancel($input: CancelOrderInput!) {
      cancelOrder(input: $input) { ... on Order { state } ... on ErrorResult { errorCode message } }
    }`), { input: { orderId, reason: cancelReason, cancelShipping: true } });
    expect(cancelOrder).toMatchObject({ state: 'Cancelled' });
  }

  it('P7: a storefront order keeps Vendure’s reasons on the Shop API', async () => {
    const { standardShippingId, dummyPaymentCode } = await createStorefrontMethods(adminClient);
    const shop = await guestOrder(shopClient, variantIds.mug[0], `p7-${randomUUID()}@customer.example`);
    await shop.setShipping(standardShippingId);
    await shop.arrangePayment();
    const paid = await shop.pay(dummyPaymentCode);
    expect(paid).toMatchObject({ state: 'PaymentSettled' });
    const refundReason = `p7-refund-${randomUUID()}`;
    const cancelReason = `p7-cancel-${randomUUID()}`;
    await adminRefundAndCancel(paid.id!, refundReason, cancelReason);

    const { orderByCode } = await anonymousRead(paid.code!);
    expect(orderByCode.payments.flatMap(payment => payment.refunds.map(refund => refund.reason))).toEqual([refundReason]);
    expect(orderByCode.payments.flatMap(payment => payment.refunds)).toMatchObject([{ state: 'Pending' }]);
    expect(orderByCode.history.items.map(entry => entry.type)).not.toContain('ORDER_REFUND_TRANSITION');
    expect(orderByCode.history.items).toContainEqual({ type: 'ORDER_CANCELLATION', data: expect.objectContaining({ reason: cancelReason }) });
  });

  it('P8: a POS order’s back-office refund and Admin cancel are neutral on the Shop API', async () => {
    const sale = freshSale();
    sale.payload.customer = { customerId: till.customerId };
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const { orderId: id, displayId: code } = result.serverRefs!;
    expect(code).toEqual(expect.any(String));
    if (!code) throw new Error('no displayId');
    const refundReason = `p8-refund-${randomUUID()}`;
    const cancelReason = `p8-cancel-${randomUUID()}`;
    await adminRefundAndCancel(id, refundReason, cancelReason, 300);

    const anonymous = await anonymousRead(code);
    const customer = await customerRead(code);
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    for (const [response, order] of [[anonymous, anonymous.orderByCode], [customer, customer.activeCustomer.orders.items[0]]] as const) {
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(refundReason);
      expect(serialized).not.toContain(cancelReason);
      expect(order.payments.flatMap(payment => payment.refunds.map(refund => refund.reason))).toEqual([SHOP_REFUND_REASON]);
      const transitions = order.history.items.filter(entry => entry.type === 'ORDER_REFUND_TRANSITION');
      expect(transitions.length).toBeGreaterThan(0);
      for (const entry of transitions) expect(entry.data.reason).toBe(SHOP_REFUND_REASON);
      expect(order.history.items).toContainEqual({ type: 'ORDER_CANCELLATION', data: expect.objectContaining({ reason: SHOP_CANCEL_REASON }) });
    }

    const { order } = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) {
      payments { refunds { reason } } history { items { type data } }
    } }`), { id });
    expect(order.payments[0].refunds).toEqual([{ reason: refundReason }]);
    expect(order.history.items).toContainEqual({ type: 'ORDER_CANCELLATION', data: expect.objectContaining({ reason: cancelReason }) });
  });

  it('P9: a rejected POS order without a snapshot shows a neutral legacy cancellation reason', async () => {
    const sale = freshSale();
    sale.payload.customer = { customerId: till.customerId };
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const { orderId: id, displayId: code } = result.serverRefs!;
    if (!code) throw new Error('no displayId');
    const db = server.app.get(TransactionalConnection).rawConnection;
    await db.getRepository(TallyCommand).update({ id: sale.id }, { status: 'needs_admin' });
    const cleared = await db.getRepository(Order).update(environment.decode(id), { customFields: { tallySnapshot: null } });
    expect(cleared.affected).toBe(1);
    const note = `p9-admin-note-${randomUUID()}`;
    const { tallyResolveNeedsAdmin } = await adminClient.query(parse(`mutation Reject($commandId: String!, $note: String!) {
      tallyResolveNeedsAdmin(commandId: $commandId, resolution: rejected, note: $note) { id status }
    }`), { commandId: sale.id, note });
    expect(tallyResolveNeedsAdmin).toEqual({ id: sale.id, status: 'rejected' });

    const { order } = await adminClient.query(parse(`query Order($id: ID!) { order(id: $id) { history { items { id type data } } } }`), { id });
    const cancellation = order.history.items.find((entry: { type: string }) => entry.type === 'ORDER_CANCELLATION');
    const legacy = `p9-legacy-${randomUUID()}`;
    const updated = await db.getRepository(OrderHistoryEntry).update(environment.decode(cancellation.id), { data: { ...cancellation.data, reason: legacy } });
    expect(updated.affected).toBe(1);

    const anonymous = await anonymousRead(code);
    const customer = await customerRead(code);
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    for (const [response, read] of [[anonymous, anonymous.orderByCode], [customer, customer.activeCustomer.orders.items[0]]] as const) {
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(note);
      expect(serialized).not.toContain(legacy);
      expect(read.history.items).toContainEqual({ type: 'ORDER_CANCELLATION', data: expect.objectContaining({ reason: SHOP_CANCEL_REASON }) });
    }
  });

  it('P10: a POS order resolved as applied without a snapshot shows neutral Admin refund and cancel reasons', async () => {
    const sale = freshSale();
    sale.payload.customer = { customerId: till.customerId };
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const { orderId: id, displayId: code } = result.serverRefs!;
    if (!code) throw new Error('no displayId');
    const db = server.app.get(TransactionalConnection).rawConnection;
    await db.getRepository(TallyCommand).update({ id: sale.id }, { status: 'needs_admin' });
    const cleared = await db.getRepository(Order).update(environment.decode(id), { customFields: { tallySnapshot: null } });
    expect(cleared.affected).toBe(1);
    const { tallyResolveNeedsAdmin } = await adminClient.query(parse(`mutation Apply($commandId: String!) {
      tallyResolveNeedsAdmin(commandId: $commandId, resolution: applied, note: "checked the till") { id status }
    }`), { commandId: sale.id });
    expect(tallyResolveNeedsAdmin).toEqual({ id: sale.id, status: 'applied' });
    const refundReason = `p10-refund-${randomUUID()}`;
    const cancelReason = `p10-cancel-${randomUUID()}`;
    await adminRefundAndCancel(id, refundReason, cancelReason, 300);

    const anonymous = await anonymousRead(code);
    const customer = await customerRead(code);
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    for (const [response, order] of [[anonymous, anonymous.orderByCode], [customer, customer.activeCustomer.orders.items[0]]] as const) {
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(refundReason);
      expect(serialized).not.toContain(cancelReason);
      expect(order.payments.flatMap(payment => payment.refunds.map(refund => refund.reason))).toEqual([SHOP_REFUND_REASON]);
      expect(order.history.items).toContainEqual({ type: 'ORDER_CANCELLATION', data: expect.objectContaining({ reason: SHOP_CANCEL_REASON }) });
    }
  });

  it('P11: a POS order moved between customers names none of them on the Shop API', async () => {
    const customers = [];
    for (const prefix of ['p11a', 'p11b']) {
      const uuid = randomUUID();
      const input = { firstName: `${prefix}-${uuid}`, lastName: `${prefix}-last-${uuid}`, emailAddress: `${prefix}-${uuid}@example.com` };
      const { createCustomer } = await adminClient.query(parse(`mutation Customer($input: CreateCustomerInput!) {
        createCustomer(input: $input) { ... on Customer { id } ... on ErrorResult { errorCode message } }
      }`), { input });
      expect(createCustomer).toMatchObject({ id: expect.any(String) });
      customers.push({ id: createCustomer.id, ...input });
    }
    const [customerA, customerB] = customers;
    const sale = freshSale();
    sale.payload.customer = { customerId: customerA.id };
    const result = await run(sale);
    expect(result.status).toBe('applied');
    const { orderId: id, displayId: code } = result.serverRefs!;
    if (!code) throw new Error('no displayId');
    for (const customerId of [customerB.id, till.customerId]) {
      await adminClient.query(parse(`mutation Customer($input: SetOrderCustomerInput!) {
        setOrderCustomer(input: $input) { id }
      }`), { input: { orderId: id, customerId } });
    }

    const anonymous = await anonymousRead(code);
    const customer = await customerRead(code);
    expect(customer.activeCustomer.orders.items).toHaveLength(1);
    for (const [response, order] of [[anonymous, anonymous.orderByCode], [customer, customer.activeCustomer.orders.items[0]]] as const) {
      const serialized = JSON.stringify(response);
      for (const { firstName, lastName, emailAddress } of customers) {
        for (const value of [firstName, lastName, emailAddress]) expect(serialized).not.toContain(value);
      }
      const changes = order.history.items.filter(entry => entry.type === 'ORDER_CUSTOMER_UPDATED');
      expect(changes).toHaveLength(2);
      for (const entry of changes) expect(entry.data).toEqual({});
    }

    const { order } = await adminClient.query(parse(`query Order($id: ID!) {
      order(id: $id) { history { items { type data } } }
    }`), { id });
    expect(order.history.items).toContainEqual({ type: 'ORDER_CUSTOMER_UPDATED', data: expect.objectContaining({
      previousCustomerName: expect.stringContaining(customerA.firstName), newCustomerName: expect.stringContaining(customerB.firstName),
    }) });
    expect(order.history.items).toContainEqual({ type: 'ORDER_CUSTOMER_UPDATED', data: expect.objectContaining({
      previousCustomerName: expect.stringContaining(customerB.firstName),
    }) });
  });
});
