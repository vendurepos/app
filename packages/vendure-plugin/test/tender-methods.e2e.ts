import {
  Channel, LanguageCode, Logger, Order, PaymentMethod, PaymentMethodEligibilityChecker, RequestContextService, TransactionalConnection, dummyPaymentHandler,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand } from '../src';
import { PluginBugError } from '../src/service/errors';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// A checker that never passes, for (l); the plugin adds its own tally-pos checker beside it.
const neverEligible = new PaymentMethodEligibilityChecker({
  code: 'never-eligible', description: [{ languageCode: LanguageCode.en, value: 'Never eligible' }], args: {}, check: () => false,
});
// A checker that throws, for (v): on a non-Tally method it must never run, on a Tally method it is ineligible.
const throwingChecker = new PaymentMethodEligibilityChecker({
  code: 'throwing-checker', description: [{ languageCode: LanguageCode.en, value: 'Throws' }], args: {}, check: () => { throw new Error('checker exploded'); },
});
type Tender = { clientPaymentId: string; method: 'cash' | 'external'; amountMinor: number; reference?: string; methodId?: string };

// 3.2a-2: /info lists the channel's Tally POS methods, and a v10 methodId chooses the Payment's method (R1–R6).
describe('tender methods', () => {
  const environment = createPluginTestEnvironment({
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler], paymentMethodEligibilityCheckers: [neverEligible, throwingChecker] },
  });
  const { server, adminClient, variantIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let base: string;
  let second: { id: string; token: string };
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) { updateProductVariants(input: $input) { id } }`),
      { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
    await createMethod('cash', 'Cash', { tender: 'cash', checker: true });
    await createMethod('card-terminal', 'Card terminal', { tender: 'card', checker: true });
    // Q3: stands for a method created before the arg existed: no stored `tender` arg, listed as `other`.
    await createMethod('voucher', 'Gift voucher', {});
    await createMethod('old-card', 'Old card', { tender: 'card', checker: true, enabled: false });
    await createMethod('stripe-like', 'Stripe-like', { handler: { code: 'dummy-payment-handler', arguments: [{ name: 'automaticSettle', value: 'true' }] } });
    await createMethod('other-channel', 'Other channel', { tender: 'card', checker: true });
    const { zones } = await adminClient.query<{ zones: { items: Array<{ id: string; name: string }> } }>(parse('query { zones { items { id name } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id token } } }`), { input: {
      code: 'tender-second', token: 'tender-second-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    second = { id: decode(createChannel.id), token: createChannel.token };
    // Vendure always keeps a method in the default channel (assignToCurrentChannel adds it, and removing it is refused),
    // so "the second channel only" is set on the row itself.
    const methods = connection.rawConnection.getRepository(PaymentMethod);
    const row = await methods.findOneOrFail({ where: { code: 'other-channel' }, relations: ['channels'] });
    row.channels = [{ id: second.id } as Channel];
    await methods.save(row);
  });
  afterAll(() => server.destroy());

  async function createMethod(code: string, name: string, options: {
    tender?: string; checker?: boolean; enabled?: boolean; handler?: { code: string; arguments: Array<{ name: string; value: string }> };
  }) {
    const { createPaymentMethod } = await adminClient.query<{ createPaymentMethod: { id: string } }>(parse(`
      mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
      code, enabled: options.enabled ?? true,
      handler: options.handler ?? { code: 'tally-pos', arguments: options.tender ? [{ name: 'tender', value: options.tender }] : [] },
      ...(options.checker ? { checker: { code: 'tally-pos', arguments: [] } } : {}),
      translations: [{ languageCode: 'en', name, description: '' }],
    } });
    ids[code] = createPaymentMethod.id;
  }
  const update = (code: string, input: Record<string, unknown>) => adminClient.query(parse(`
    mutation Update($input: UpdatePaymentMethodInput!) { updatePaymentMethod(input: $input) { id } }`), { input: { id: ids[code], ...input } });
  const info = async (headers: Record<string, string> = {}) => (await fetch(`${base}/tally/v1/info`, {
    headers: { Authorization: `Bearer ${adminClient.getAuthToken()}`, ...headers } })).json();
  function sale(version: number, tenders: Array<Omit<Tender, 'clientPaymentId' | 'amountMinor'> & { amountMinor?: number }>, quantity = 1) {
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity, unitPriceMinor: 800 }]), version };
    let left = command.payload.totalMinor;
    (command.payload as { payments: Tender[] }).payments = tenders.map((tender, index) => {
      const amountMinor = index === tenders.length - 1 ? left : tender.amountMinor!;
      left -= amountMinor;
      return { clientPaymentId: orderCommand([]).id, ...tender, amountMinor };
    });
    return command;
  }
  const send = (command: object) => run(command as unknown as CommandEnvelope<OrderCreatePayload>);
  async function orderOf(orderId: string) {
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({ where: { id: decode(orderId) }, relations: ['payments'] });
    return { order, payments: order.payments.sort((a, b) => Number(a.id) - Number(b.id)) };
  }
  const methodsOf = async (orderId: string) => (await orderOf(orderId)).payments.map(payment => payment.method);
  const remove = (code: string) => adminClient.query(parse('mutation Delete($id: ID!) { deletePaymentMethod(id: $id, force: true) { result } }'), { id: ids[code] });
  // 3.2a-2 fix 2: a methodId naming no Tally method in the channel is applied under tally-pos, code kept, reason unknown.
  async function expectUnknown(command: ReturnType<typeof sale>, index: number) {
    const { clientPaymentId, methodId } = (command.payload.payments as Tender[])[index];
    const result = await send(command);
    expect(result).toMatchObject({ id: command.id, status: 'applied' });
    expect(result.warnings).toEqual([{ code: 'payment_method_fallback', clientPaymentId, methodId, reason: 'unknown' }]);
    const { payments } = await orderOf(result.serverRefs!.orderId);
    expect(payments[index]).toMatchObject({ method: 'tally-pos', metadata: { tender: { methodId } } });
    return payments.map(payment => payment.method);
  }
  const fallback = (command: ReturnType<typeof sale>, methodId: string, reason: string) =>
    ({ code: 'payment_method_fallback', clientPaymentId: command.payload.payments[0].clientPaymentId, methodId, reason });

  it('(f) /info lists the enabled Tally methods by id, never tally-pos, disabled, other-channel or non-Tally ones', async () => {
    const voucher = await connection.rawConnection.getRepository(PaymentMethod).findOneByOrFail({ code: 'voucher' });
    expect(voucher.handler.args.map(arg => arg.name)).not.toContain('tender');
    expect((await info()).paymentMethods).toEqual([
      { code: 'cash', name: 'Cash', kind: 'cash' },
      { code: 'card-terminal', name: 'Card terminal', kind: 'card' },
      { code: 'voucher', name: 'Gift voucher', kind: 'other' },
    ]);
    expect((await info({ 'vendure-token': second.token })).paymentMethods).toEqual([{ code: 'other-channel', name: 'Other channel', kind: 'card' }]);
  });

  it('(g) a v10 split records card-terminal by methodId and cash by method (R2); tallyPayments keeps methodId', async () => {
    const command = sale(10, [{ method: 'external', reference: 'card-1', methodId: 'card-terminal', amountMinor: 500 }, { method: 'cash' }]);
    const result = await send(command);
    expect(result).toEqual({ id: command.id, status: 'applied', serverRefs: expect.any(Object) });
    const { order, payments } = await orderOf(result.serverRefs!.orderId);
    expect(payments.map(payment => payment.method)).toEqual(['card-terminal', 'cash']);
    expect(payments.map(payment => payment.metadata)).toEqual(command.payload.payments.map(tender => ({ tender })));
    expect(JSON.parse(order.customFields.tallyPayments!)).toEqual(command.payload.payments);
    expect(command.payload.payments[0]).toMatchObject({ methodId: 'card-terminal' });
  });

  // The old resend after switching stripe-like to the Tally handler is dropped: the first send now applies, so there is
  // nothing left to resend, and stripe-like stays a non-Tally method for the cases below.
  it('(h) a methodId on a non-Tally handler is applied under tally-pos with the code kept, reason unknown', async () => {
    expect(await expectUnknown(sale(10, [{ method: 'external', methodId: 'stripe-like' }]), 0)).toEqual(['tally-pos']);
  });

  it('(i) a methodId of another channel\'s Tally method is applied under tally-pos with the code kept, reason unknown', async () => {
    expect(await expectUnknown(sale(10, [{ method: 'cash', amountMinor: 300, methodId: 'cash' }, { method: 'external', methodId: 'other-channel' }]), 1))
      .toEqual(['cash', 'tally-pos']);
  });

  it('(j) a disabled method falls back to tally-pos with the code kept and a disabled warning', async () => {
    const command = sale(10, [{ method: 'external', methodId: 'old-card' }]);
    const result = await send(command);
    expect(result).toMatchObject({ status: 'applied', warnings: [fallback(command, 'old-card', 'disabled')] });
    const { order, payments } = await orderOf(result.serverRefs!.orderId);
    expect(payments.map(payment => [payment.method, payment.metadata.tender.methodId])).toEqual([['tally-pos', 'old-card']]);
    expect(JSON.parse(order.customFields.tallyPayments!)[0].methodId).toBe('old-card');
  });

  it('(k) a replay after the method is disabled stays duplicate; a sale queued before it was disabled falls back', async () => {
    const command = sale(10, [{ method: 'external', methodId: 'card-terminal' }]);
    const queued = sale(10, [{ method: 'external', methodId: 'card-terminal' }]);
    const first = await send(command);
    expect(first.status).toBe('applied');
    expect(await methodsOf(first.serverRefs!.orderId)).toEqual(['card-terminal']);
    await update('card-terminal', { enabled: false });
    try {
      expect(await send({ ...command, attempt: 2 })).toMatchObject({ status: 'duplicate', serverRefs: { orderId: first.serverRefs!.orderId } });
      const later = await send(queued);
      expect(later).toMatchObject({ status: 'applied', warnings: [fallback(queued, 'card-terminal', 'disabled')] });
      expect(await methodsOf(later.serverRefs!.orderId)).toEqual(['tally-pos']);
    } finally {
      await update('card-terminal', { enabled: true });
    }
  });

  it('(l) a method whose checker fails falls back to tally-pos with an ineligible warning', async () => {
    await update('voucher', { checker: { code: 'never-eligible', arguments: [] } });
    const command = sale(10, [{ method: 'external', methodId: 'voucher' }]);
    const result = await send(command);
    expect(result).toMatchObject({ status: 'applied', warnings: [fallback(command, 'voucher', 'ineligible')] });
    const { order, payments } = await orderOf(result.serverRefs!.orderId);
    expect(payments.map(payment => [payment.method, payment.metadata.tender.methodId])).toEqual([['tally-pos', 'voucher']]);
    expect(JSON.parse(order.customFields.tallyPayments!)[0].methodId).toBe('voucher');
  });

  it('(n) an older till\'s v7 cash sale is recorded under the channel\'s cash method (R2)', async () => {
    const command = sale(7, [{ method: 'cash' }]);
    const result = await send(command);
    expect(result).toEqual({ id: command.id, status: 'applied', serverRefs: expect.any(Object) });
    expect(await methodsOf(result.serverRefs!.orderId)).toEqual(['cash']);
  });

  it('(o) with tally-pos disabled, a v10 card-terminal sale is store_configuration, unchanged (R4)', async () => {
    const methods = connection.rawConnection.getRepository(PaymentMethod);
    await methods.update({ code: 'tally-pos' }, { enabled: false });
    try {
      const command = sale(10, [{ method: 'external', methodId: 'card-terminal' }]);
      expect(await send(command)).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await connection.rawConnection.getRepository(TallyCommand).countBy({ id: command.id })).toBe(0);
    } finally {
      await methods.update({ code: 'tally-pos' }, { enabled: true });
    }
  });

  it('(q) an admin\'s rejection of a needs_admin sale cancels its card-terminal payment', async () => {
    const recipe = server.app.get(OrderCreateService);
    const command = sale(10, [{ method: 'external', methodId: 'card-terminal' }]);
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'payments' && order.customFields.tallyClientOrderId === command.payload.clientOrderId) throw new PluginBugError('after payments');
    };
    try {
      await expect(send(command)).rejects.toMatchObject({ kind: 'needs_admin' });
    } finally {
      recipe.testObserver = undefined;
    }
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    await recipe.resolveNeedsAdmin(ctx, command.id, 'rejected', 'card sale discarded');
    const [order] = await connection.rawConnection.getRepository(Order).find({
      where: { customFields: { tallyRejectedClientOrderId: command.payload.clientOrderId } }, relations: ['payments'] });
    expect(order.payments.map(payment => [payment.method, payment.state])).toEqual([['card-terminal', 'Cancelled']]);
  });

  // 3.2a-2 review: Vendure cancels a Payment only while its method is enabled.
  it('(t) an admin\'s rejection is refused while the payment\'s method is disabled, and cancels it once enabled again', async () => {
    const recipe = server.app.get(OrderCreateService);
    const command = sale(10, [{ method: 'external', methodId: 'card-terminal' }]);
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'payments' && order.customFields.tallyClientOrderId === command.payload.clientOrderId) throw new PluginBugError('after payments');
    };
    try {
      await expect(send(command)).rejects.toMatchObject({ kind: 'needs_admin' });
    } finally {
      recipe.testObserver = undefined;
    }
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    await update('card-terminal', { enabled: false });
    try {
      await expect(recipe.resolveNeedsAdmin(ctx, command.id, 'rejected', 'card sale discarded')).rejects.toThrow('its method card-terminal is disabled');
      expect(await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: command.id })).toMatchObject({ status: 'needs_admin' });
    } finally {
      await update('card-terminal', { enabled: true });
    }
    await recipe.resolveNeedsAdmin(ctx, command.id, 'rejected', 'card sale discarded');
    const [order] = await connection.rawConnection.getRepository(Order).find({
      where: { customFields: { tallyRejectedClientOrderId: command.payload.clientOrderId } }, relations: ['payments'] });
    expect(order.payments.map(payment => [payment.method, payment.state])).toEqual([['card-terminal', 'Cancelled']]);
  });

  it('(u) a v10 methodId that is not a string is invalid_payload, before any method is looked up', async () => {
    const command = sale(10, [{ method: 'external', methodId: 5 as unknown as string }]);
    expect(await send(command)).toEqual({ id: command.id, status: 'rejected', error: { code: 'invalid_payload',
      message: 'payments[0].methodId: expected 1 to 64 characters' } });
  });

  // 3.2a-2 fix 2: Vendure's getEligiblePaymentMethods runs every enabled method's checker in the channel, and one that
  // throws throws out of it; the plugin runs only the checker of a method a payment resolved to.
  describe('a checker that throws', () => {
    beforeAll(async () => {
      await createMethod('boom', 'Boom', { handler: { code: 'dummy-payment-handler', arguments: [{ name: 'automaticSettle', value: 'true' }] } });
      await createMethod('fragile', 'Fragile', { tender: 'card' });
      for (const code of ['boom', 'fragile']) await update(code, { checker: { code: 'throwing-checker', arguments: [] } });
    });
    afterAll(async () => {
      for (const code of ['boom', 'fragile']) await remove(code);
    });

    it('(v) a non-Tally method whose checker throws changes nothing for a card-terminal or a v7 cash sale', async () => {
      for (const [command, method] of [[sale(10, [{ method: 'external', methodId: 'card-terminal' }]), 'card-terminal'], [sale(7, [{ method: 'cash' }]), 'cash']] as const) {
        const result = await send(command);
        expect(result).toEqual({ id: command.id, status: 'applied', serverRefs: expect.any(Object) });
        expect(await methodsOf(result.serverRefs!.orderId)).toEqual([method]);
      }
    });

    it('(v2) a Tally method whose checker throws falls back to tally-pos, ineligible, logged once by code and message', async () => {
      const warn = vi.spyOn(Logger, 'warn');
      try {
        const command = sale(10, [{ method: 'external', methodId: 'fragile' }]);
        const result = await send(command);
        expect(result).toMatchObject({ status: 'applied', warnings: [fallback(command, 'fragile', 'ineligible')] });
        expect(await methodsOf(result.serverRefs!.orderId)).toEqual(['tally-pos']);
        expect(warn.mock.calls.filter(([message]) => String(message).includes('fragile')).map(([message]) => message))
          .toEqual(['Payment method fragile: its eligibility checker threw (checker exploded)']);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('(x2) an admin\'s rejection is refused once the payment\'s Tally method is deleted, and the payment stays Settled', async () => {
    await createMethod('held-gone', 'Held gone', { tender: 'card', checker: true });
    const recipe = server.app.get(OrderCreateService);
    const command = sale(10, [{ method: 'external', methodId: 'held-gone' }]);
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'payments' && order.customFields.tallyClientOrderId === command.payload.clientOrderId) throw new PluginBugError('after payments');
    };
    try {
      await expect(send(command)).rejects.toMatchObject({ kind: 'needs_admin' });
    } finally {
      recipe.testObserver = undefined;
    }
    await remove('held-gone');
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    await expect(recipe.resolveNeedsAdmin(ctx, command.id, 'rejected', 'card sale discarded')).rejects.toThrow('its method held-gone no longer exists in this channel');
    expect(await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: command.id })).toMatchObject({ status: 'needs_admin' });
    const [order] = await connection.rawConnection.getRepository(Order).find({
      where: { customFields: { tallyClientOrderId: command.payload.clientOrderId } }, relations: ['payments'] });
    expect(order.payments.map(payment => [payment.method, payment.state])).toEqual([['held-gone', 'Settled']]);
  });

  describe('older tills with no cash method on the channel', () => {
    beforeAll(async () => {
      await adminClient.query(parse('mutation Delete($id: ID!) { deletePaymentMethod(id: $id, force: true) { result } }'), { id: ids.cash });
    });

    it('(m) a v7 cash and a v4 external sale settle under tally-pos exactly as before, also beside a disabled cash method', async () => {
      const cases = [sale(7, [{ method: 'cash' }]), sale(4, [{ method: 'external', reference: 'card-1' }])];
      for (const command of cases) {
        const result = await send(command);
        expect(result).toEqual({ id: command.id, status: 'applied',
          serverRefs: { orderId: expect.any(String), displayId: expect.any(String), totalMinor: command.payload.totalMinor } });
        const { payments } = await orderOf(result.serverRefs!.orderId);
        expect(payments.map(payment => [payment.method, payment.metadata])).toEqual([['tally-pos', { tender: command.payload.payments[0] }]]);
      }
      // Mutation 2f: R2 must match only a listed method, so a disabled cash method changes nothing.
      await createMethod('cash', 'Cash', { tender: 'cash', checker: true, enabled: false });
      try {
        const command = sale(7, [{ method: 'cash' }]);
        const result = await send(command);
        expect(result).toEqual({ id: command.id, status: 'applied',
          serverRefs: { orderId: expect.any(String), displayId: expect.any(String), totalMinor: command.payload.totalMinor } });
        expect(await methodsOf(result.serverRefs!.orderId)).toEqual(['tally-pos']);
      } finally {
        await adminClient.query(parse('mutation Delete($id: ID!) { deletePaymentMethod(id: $id, force: true) { result } }'), { id: ids.cash });
      }
    });

    it('(r) the sales report totals cash and external across sales before and after the cash method exists', async () => {
      const registerId = orderCommand([]).id;
      const at = '2026-04-01T09:00:00.000Z';
      const place = async (command: ReturnType<typeof sale>) => {
        Object.assign(command, { createdAt: at });
        Object.assign(command.payload, { createdAt: at, registerId });
        const result = await send(command);
        expect(result.status).toBe('applied');
        return { orderId: result.serverRefs!.orderId, amount: command.payload.totalMinor };
      };
      const a = await place(sale(7, [{ method: 'cash' }], 1));
      const b = await place(sale(7, [{ method: 'external', reference: 'card-1' }], 2));
      await createMethod('cash', 'Cash', { tender: 'cash', checker: true });
      const c = await place(sale(7, [{ method: 'cash' }], 3));
      const d = await place(sale(10, [{ method: 'external', reference: 'card-2', methodId: 'card-terminal' }], 4));
      expect([await methodsOf(c.orderId), await methodsOf(d.orderId)]).toEqual([['cash'], ['card-terminal']]);
      const response = await fetch(`${base}/tally/v1/reports/sales?${new URLSearchParams({
        from: '2026-04-01T00:00:00Z', to: '2026-04-02T00:00:00Z', registerId })}`, { headers: { Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1' } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orders.count).toBe(4);
      expect(body.byMethod).toEqual([
        { method: 'cash', salesMinor: a.amount + c.amount, refundsMinor: 0 },
        { method: 'external', salesMinor: b.amount + d.amount, refundsMinor: 0 },
      ]);
      // Nothing is rewritten: the first two stay under tally-pos once the cash method exists.
      expect([await methodsOf(a.orderId), await methodsOf(b.orderId)]).toEqual([['tally-pos'], ['tally-pos']]);
    });
  });
});
