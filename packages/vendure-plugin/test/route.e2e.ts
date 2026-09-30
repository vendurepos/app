import { randomUUID } from 'node:crypto';
import { Controller, Post } from '@nestjs/common';
import {
  Allow, Ctx, Logger, Order, OrderService, Payment, PaymentService, Permission, PluginCommonModule, ProductVariantService, RequestContext,
  RequestContextService, ShippingMethod, StockLevel, StockMovement, StockMovementService, TransactionalConnection, VendurePlugin,
  defaultOrderProcess,
} from '@vendure/core';
import type { OrderProcess, OrderState } from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin } from '../src';
import { TEST_HOOKS_ENV } from '../src/service/order-create.service';
import type { CommandEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// Another plugin's REST controller: apiType 'custom' too, but not the command route (item 2).
@Controller('vp2-dummy')
class DummyPaymentController {
  constructor(private orders: OrderService, private payments: PaymentService, private connection: TransactionalConnection) {}

  @Post('pay')
  @Allow(Permission.CreateOrder)
  async pay(@Ctx() ctx: RequestContext) {
    const order = await this.orders.createDraft(ctx);
    order.customFields = { ...order.customFields, tallyClientOrderId: randomUUID() };
    await this.connection.getRepository(ctx, Order).save(order);
    const payment = await this.payments.createPayment(ctx, order, 100, 'tally-pos', {}) as Payment;
    return { apiType: ctx.apiType, state: payment.state, errorMessage: payment.errorMessage };
  }
}

@VendurePlugin({ imports: [PluginCommonModule], controllers: [DummyPaymentController] })
class DummyRestPlugin {}

// A merchant's explicit CORS header list, set ahead of TallyPosPlugin, which extends it with X-Tally-Protocol.
// (mergeConfig cannot replace testConfig's `cors: true` with an object.)
@VendurePlugin({
  configuration: config => {
    config.apiOptions.cors = { origin: true, credentials: true, allowedHeaders: ['Authorization', 'Content-Type', 'vendure-token'] };
    return config;
  },
})
class MerchantCorsPlugin {}

let refuseCancel = false;

describe('POST /tally/v1/commands', () => {
  // An order process that refuses Cancelled while `refuseCancel` is set, as a merchant's own process could (ruling 4).
  const environment = createPluginTestEnvironment({ orderOptions: { process: [defaultOrderProcess, {
    onTransitionStart: (_from, to) => (refuseCancel && to === 'Cancelled' ? 'Test process refuses Cancelled' : undefined),
  } satisfies OrderProcess<OrderState>] } }, [MerchantCorsPlugin, TallyPosPlugin, DummyRestPlugin]);
  const { server, adminClient, variantIds, serviceIds, encode } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let base: string;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    base = await server.app.getUrl();
    process.env[TEST_HOOKS_ENV] = '1';
  });
  afterAll(async () => {
    delete process.env[TEST_HOOKS_ENV];
    await server.destroy();
  });
  afterEach(() => {
    recipe.testObserver = undefined;
    recipe.testHooks = {};
  });

  const mug = () => orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
  const headers = (extra: Record<string, string> = {}) => ({
    'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1', ...extra,
  });
  async function post(body: unknown, extra?: Record<string, string>) {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: headers(extra), body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  }
  const ledgerFor = (input: CommandEnvelope) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id });
  const ordersFor = (input: CommandEnvelope<{ clientOrderId: string }>) => connection.rawConnection.getRepository(Order).find({
    where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } }, relations: ['payments'],
  });
  const ledgerCount = () => connection.rawConnection.getRepository(TallyCommand).count();
  function gate() {
    let enter!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    return { reached, release, hold: async () => { enter(); await released; } };
  }

  it('applies a batch in order, one transaction per command, and answers 200 { results }; the POS payments settle', async () => {
    const [a, b] = [mug(), mug()];
    const response = await post({ commands: [a, b] });
    expect(response.status).toBe(200);
    expect(response.body.results.map((result: { id: string; status: string }) => [result.id, result.status]))
      .toEqual([[a.id, 'applied'], [b.id, 'applied']]);
    for (const input of [a, b]) {
      const [order] = await ordersFor(input);
      expect(order.payments.map(payment => payment.state)).toEqual(['Settled']);
      expect(await ledgerFor(input)).toMatchObject({ status: 'applied' });
    }
    // A replay of the whole batch answers duplicate with the same refs.
    const replay = await post({ commands: [a, b] });
    expect(replay.body.results).toEqual(response.body.results.map((result: object) => ({ ...result, status: 'duplicate' })));
  });

  it('requires X-Tally-Protocol: 1, else 400 unsupported_protocol, before any write', async () => {
    const before = await ledgerCount();
    for (const protocol of [undefined, '2']) {
      const sent: Record<string, string> = headers(protocol === undefined ? {} : { 'X-Tally-Protocol': protocol });
      if (protocol === undefined) delete sent['X-Tally-Protocol'];
      const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST', body: JSON.stringify({ commands: [mug()] }), headers: sent });
      expect(response.status, String(protocol)).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'unsupported_protocol' });
    }
    expect(await ledgerCount()).toBe(before);
  });

  it('validates the whole batch first: 1 to 50 well-formed envelopes, else 400 invalid_payload and nothing runs', async () => {
    const valid = mug();
    const cases: unknown[] = [
      {}, { commands: 'x' }, { commands: [] }, { commands: Array.from({ length: 51 }, () => mug()) },
      { commands: [valid, { ...mug(), id: 5 }] }, { commands: [valid, { ...mug(), attempt: 0 }] }, { commands: [valid, null] },
    ];
    for (const body of cases) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'invalid_payload', message: expect.any(String) });
    }
    expect(await ledgerFor(valid)).toBeNull();
    // Fifty is allowed.
    const fifty = Array.from({ length: 50 }, () => ({ ...valid, id: randomUUID(), type: 'register.session.open' }));
    const accepted = await post({ commands: fifty });
    expect(accepted.status).toBe(200);
    expect(accepted.body.results).toHaveLength(50);
  });

  it('accepts a body above Vendure\'s 100 kB default and refuses one above 1 MB', async () => {
    const input = mug();
    const large = await post({ commands: [input], padding: 'x'.repeat(200_000) });
    expect(large.status).toBe(200);
    expect(large.body.results[0]).toMatchObject({ id: input.id, status: 'applied' });
    const tooLarge = await post({ commands: [mug()], padding: 'x'.repeat(1_100_000) });
    expect(tooLarge).toEqual({ status: 413, body: { code: 'invalid_payload', message: 'request entity too large' } });
    // Malformed JSON is the client's fault too, never a 500 the outbox would retry.
    expect(await post('{"commands": [')).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
  });

  it('refuses an anonymous caller, and allows a CORS preflight carrying X-Tally-Protocol without auth', async () => {
    const anonymous = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1' }, body: JSON.stringify({ commands: [mug()] }),
    });
    expect(anonymous.status).toBe(403);
    const preflight = await fetch(`${base}/tally/v1/commands`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://till.example', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-tally-protocol',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://till.example');
    expect(preflight.headers.get('access-control-allow-headers')!.toLowerCase().split(',')).toContain('x-tally-protocol');
  });

  it('item 2: another plugin\'s REST controller (apiType custom) cannot settle a tally-pos payment', async () => {
    const response = await fetch(`${base}/vp2-dummy/pay`, { method: 'POST', headers: headers() });
    expect(await response.json()).toEqual({
      apiType: 'custom', state: 'Declined', errorMessage: 'tally-pos is only available to the POS route',
    });
  });

  it('stops at a 409 in_progress while another request holds the claim; the later command does not run', async () => {
    const [held, later] = [mug(), mug()];
    const barrier = gate();
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'addItemToOrder' && order.customFields.tallyClientOrderId === held.payload.clientOrderId) await barrier.hold();
    };
    const first = post({ commands: [held] });
    await barrier.reached;
    const second = await post({ commands: [held, later] });
    barrier.release();
    expect(second).toEqual({ status: 409, body: { code: 'in_progress', id: held.id } });
    expect(await ledgerFor(later)).toBeNull();
    expect((await first).body.results[0]).toMatchObject({ status: 'applied' });
  });

  it('stops at a 503 transient without leaking internals; earlier commands stay committed and replay as duplicate', async () => {
    const [a, b, c] = [mug(), mug(), mug()];
    recipe.testObserver = async (_stage, _ctx, order) => {
      if (order.customFields.tallyClientOrderId === b.payload.clientOrderId) throw new Error('injected secret detail');
    };
    const response = await post({ commands: [a, b, c] });
    expect(response).toEqual({ status: 503, body: { code: 'transient', id: b.id, message: 'Temporary failure, retry later.' } });
    expect(await ledgerFor(a)).toMatchObject({ status: 'applied' });
    expect(await ledgerFor(b)).toBeNull();
    expect(await ledgerFor(c)).toBeNull();
    recipe.testObserver = undefined;
    const retry = await post({ commands: [a, b, c] });
    expect(retry.body.results.map((result: { status: string }) => result.status)).toEqual(['duplicate', 'applied', 'applied']);
  });

  it('item 4: while a rejection is being recorded, a resend of the same id gets 409, never a second recipe run', async () => {
    // A deterministic refusal (an unknown variant), stored on the claim before the recipe (re-ruling 4).
    const input = orderCommand([{ variantId: encode(999999), quantity: 1, unitPriceMinor: 800 }]);
    const barrier = gate();
    recipe.testHooks.beforeStoringRejection = async id => {
      if (id === input.id) await barrier.hold();
    };
    const createDraft = vi.spyOn(server.app.get(OrderService), 'createDraft'); // Calls Vendure unchanged.
    try {
      const first = post({ commands: [input] });
      await barrier.reached;
      // The claim is held while the rejection is being stored: the resend waits out the claim's lock_timeout.
      expect(await post({ commands: [input] })).toEqual({ status: 409, body: { code: 'in_progress', id: input.id } });
      barrier.release();
      const result = (await first).body.results[0];
      expect(result).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'unknown_variant' } });
      expect((await post({ commands: [input] })).body.results[0]).toEqual(result);
      expect(createDraft).not.toHaveBeenCalled();
      expect(await ordersFor(input)).toHaveLength(0);
    } finally {
      createDraft.mockRestore();
    }
  });

  it('item 7: a crash after the commit, before the response; the resend is duplicate with the same orderId and one order', async () => {
    const input = mug();
    let crashes = 0;
    recipe.testHooks.afterCommit = async id => {
      if (id === input.id && !crashes++) throw new Error('crash after commit');
    };
    const crashed = await post({ commands: [input] });
    expect(crashed.status).toBe(500);
    const [order] = await ordersFor(input);
    expect(await ledgerFor(input)).toMatchObject({ status: 'applied' });
    const resend = await post({ commands: [input] });
    expect(resend.status).toBe(200);
    expect(resend.body.results[0]).toMatchObject({ id: input.id, status: 'duplicate', serverRefs: { orderId: encode(order.id) } });
    expect(await ordersFor(input)).toHaveLength(1);
    // The hooks are gated: without the environment variable the same throwing hook never runs.
    const other = mug();
    recipe.testHooks.afterCommit = async () => { throw new Error('crash after commit'); };
    delete process.env[TEST_HOOKS_ENV];
    try {
      expect((await post({ commands: [other] })).status).toBe(200);
    } finally {
      process.env[TEST_HOOKS_ENV] = '1';
    }
  });

  it('item 5: a failed stock take-back marks needs_admin, keeps the sale and the claim, and answers 409 until an admin resolves it', async () => {
    const stock = server.app.get(StockMovementService);
    const adjust = stock.adjustProductVariantStock.bind(stock);
    const logged = vi.spyOn(Logger, 'error');
    // Print has 2 on hand, so selling 3 tops up (the first adjustment) and then takes the top-up back (the second).
    const print = () => orderCommand([{ variantId: variantIds.print[0], quantity: 3, unitPriceMinor: 4500 }]);
    const needsAdmin = async (input = print()) => {
      const spy = vi.spyOn(stock, 'adjustProductVariantStock')
        .mockImplementationOnce(adjust)
        .mockImplementationOnce(() => Promise.reject(new Error('injected take-back failure')));
      try {
        expect(await post({ commands: [input] })).toEqual({ status: 409, body: { code: 'in_progress', id: input.id } });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      return input;
    };
    try {
      const input = await needsAdmin();
      const row = await ledgerFor(input);
      expect(row).toMatchObject({ status: 'needs_admin', result: { status: 'applied' } });
      const orders = await ordersFor(input);
      expect(orders).toHaveLength(1);
      expect(orders[0].state).toBe('Delivered');
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`order.create ${input.id} needs an admin`), 'TallyPosPlugin', expect.any(String));
      // Resends answer 409 in_progress, never duplicate or rejected, and never run the recipe again.
      expect(await post({ commands: [input] })).toEqual({ status: 409, body: { code: 'in_progress', id: input.id } });
      // Refinement 2: nor does a new command id for the same sale get round the mark.
      const requeued = { ...input, id: mug().id };
      expect(await post({ commands: [requeued] })).toEqual({ status: 409, body: { code: 'in_progress', id: requeued.id } });
      expect(await ledgerFor(requeued)).toBeNull();
      expect(await ordersFor(input)).toHaveLength(1);

      const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
      await expect(recipe.resolveNeedsAdmin(ctx, mug().id, 'applied', 'no such row')).rejects.toThrow('does not need an admin');
      const warned = vi.spyOn(Logger, 'warn');
      await recipe.resolveNeedsAdmin(ctx, input.id, 'applied', 'stock corrected by hand');
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`${input.id}: needs_admin resolved as applied (stock corrected by hand)`), 'TallyPosPlugin');
      warned.mockRestore();
      const replay = await post({ commands: [input] });
      expect(replay.body.results[0]).toEqual({ ...row!.result, status: 'duplicate' });
      expect(replay.body.results[0].serverRefs.orderId).toBe(encode(orders[0].id));

      // Ruling 4: rejecting cancels the order; while it cannot be cancelled, the rejection is refused.
      // A clientOrderId of the full 255 characters, which the rejection moves to tallyRejectedClientOrderId.
      const longInput = print();
      longInput.payload.clientOrderId = randomUUID().padEnd(255, 'x');
      const printStock = async () => (await connection.rawConnection.getRepository(StockLevel).find({
        where: { productVariantId: serviceIds.print[0] } })).reduce((sum, level) => sum + level.stockOnHand, 0);
      const stockBefore = await printStock();
      const rejectedInput = await needsAdmin(longInput);
      const [live] = await ordersFor(rejectedInput);
      const paymentStates = async () => (await connection.rawConnection.getRepository(Payment).find({
        where: { order: { id: live.id } } })).map(payment => payment.state);
      // N4: the top-up the failed take-back left is still on hand, and the POS payment is settled.
      const stockNeedsAdmin = await printStock();
      expect(stockNeedsAdmin).toBe(Math.max(stockBefore, 3) - 3);
      expect(await paymentStates()).toEqual(['Settled']);
      const orderRepository = connection.rawConnection.getRepository(Order);
      const cancellations = () => connection.rawConnection.getRepository(StockMovement).count({ where: { type: 'CANCELLATION' as never } });
      const cancellationsBefore = await cancellations();
      refuseCancel = true;
      try {
        await expect(recipe.resolveNeedsAdmin(ctx, rejectedInput.id, 'rejected', 'order cancelled by the admin')).rejects
          .toThrow(`Command ${rejectedInput.id} is not rejected: order ${live.code} cannot be cancelled (ORDER_STATE_TRANSITION_ERROR`);
      } finally {
        refuseCancel = false;
      }
      expect(await ledgerFor(rejectedInput)).toMatchObject({ status: 'needs_admin' });
      expect(await orderRepository.findOneByOrFail({ id: live.id })).toMatchObject({
        state: 'Delivered', customFields: { tallyClientOrderId: rejectedInput.payload.clientOrderId },
      });
      expect(await cancellations()).toBe(cancellationsBefore);
      // N4: a refused rejection changes nothing, the take-back and the payment cancellation included.
      expect(await printStock()).toBe(stockNeedsAdmin);
      expect(await paymentStates()).toEqual(['Settled']);

      await recipe.resolveNeedsAdmin(ctx, rejectedInput.id, 'rejected', 'order cancelled by the admin');
      expect(await orderRepository.findOneByOrFail({ id: live.id })).toMatchObject({
        state: 'Cancelled', customFields: {
          tallyClientOrderId: null, tallyRejectedClientOrderId: longInput.payload.clientOrderId, tallyRejected: true,
        },
      });
      expect(await cancellations()).toBe(cancellationsBefore + 1);
      // N4: the top-up is taken back and Vendure's cancellation restocks the sale: the stock is as before the sale.
      expect(await printStock()).toBe(stockBefore);
      expect(await paymentStates()).toEqual(['Cancelled']);
      expect((await post({ commands: [rejectedInput] })).body.results[0]).toEqual({ id: rejectedInput.id, status: 'rejected', error: {
        code: 'platform_error', message: 'TALLY_ADMIN_REJECTED: order cancelled by the admin',
        data: { platformCode: 'TALLY_ADMIN_REJECTED', platformMessage: 'order cancelled by the admin' },
      } });
      await expect(recipe.resolveNeedsAdmin(ctx, rejectedInput.id, 'applied', 'again')).rejects.toThrow('does not need an admin');
      // The till's Retry under a new id is a new sale, recorded once.
      const retry = { ...rejectedInput, id: mug().id };
      const sold = (await post({ commands: [retry] })).body.results[0];
      expect(sold).toMatchObject({ id: retry.id, status: 'applied' });
      expect(sold.serverRefs.orderId).not.toBe(encode(live.id));
      expect((await ordersFor(rejectedInput)).map(order => [encode(order.id), order.state])).toEqual([[sold.serverRefs.orderId, 'Delivered']]);
      expect((await post({ commands: [retry] })).body.results[0]).toEqual({ ...sold, status: 'duplicate' });
    } finally {
      logged.mockRestore();
    }
  });

  it('@Allow(CreateOrder): a CreateOrder-only administrator sells and repairs the setup; a ReadOrder-only one is refused', async () => {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    // A role on the default channel with one permission, an administrator holding it, and that administrator's bearer token.
    async function tokenWith(permission: 'CreateOrder' | 'ReadOrder') {
      const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
        createRole(input: $input) { id }
      }`), { input: { code: `till-${permission}-${randomUUID()}`, description: permission, permissions: [permission], channelIds: [activeChannel.id] } });
      const emailAddress = `${permission}-${randomUUID()}@till.example`;
      await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
        { input: { firstName: 'Till', lastName: permission, emailAddress, password: 'till-password', roleIds: [createRole.id] } });
      const response = await fetch(`${base}/admin-api`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") {
          ... on CurrentUser { id } ... on ErrorResult { errorCode } } }` }),
      });
      expect((await response.json()).data.login).toMatchObject({ id: expect.any(String) });
      const token = response.headers.get('vendure-auth-token');
      expect(token).toBeTruthy();
      return { Authorization: `Bearer ${token}` };
    }
    const createOrder = await tokenWith('CreateOrder');
    const readOrder = await tokenWith('ReadOrder');

    const sold = mug();
    const response = await post({ commands: [sold] }, createOrder);
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ id: sold.id, status: 'applied' });
    expect((await ordersFor(sold)).map(order => order.state)).toEqual(['Delivered']);

    // The on-demand repair runs with the till's ctx: with tally-in-store soft-deleted, a CreateOrder-only sale recreates it.
    const liveShipping = () => connection.rawConnection.getRepository(ShippingMethod).find({
      where: { code: 'tally-in-store', deletedAt: IsNull() },
    });
    const [shipping] = await liveShipping();
    expect(await adminClient.query(parse('mutation Delete($id: ID!) { deleteShippingMethod(id: $id) { result } }'),
      { id: encode(shipping.id) })).toEqual({ deleteShippingMethod: { result: 'DELETED' } });
    expect(await liveShipping()).toHaveLength(0);
    const repaired = mug();
    const repair = await post({ commands: [repaired] }, createOrder);
    expect(repair.status).toBe(200);
    expect(repair.body.results[0]).toMatchObject({ id: repaired.id, status: 'applied' });
    const live = await liveShipping();
    expect(live).toHaveLength(1);
    expect(String(live[0].id)).not.toBe(String(shipping.id));

    const refused = mug();
    expect((await post({ commands: [refused] }, readOrder)).status).toBe(403);
    expect(await ledgerFor(refused)).toBeNull();
  });
});
