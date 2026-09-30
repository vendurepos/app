import { randomUUID } from 'node:crypto';
import { Controller, Post } from '@nestjs/common';
import {
  Allow, Ctx, Logger, Order, OrderService, Payment, PaymentMethod, PaymentService, Permission, PluginCommonModule, ProductVariantService, RequestContext,
  RequestContextService, ShippingMethod, StockLevel, StockMovement, StockMovementService, TransactionalConnection, VendurePlugin,
  defaultOrderProcess,
} from '@vendure/core';
import type { OrderProcess, OrderState } from '@vendure/core';
import { parse } from 'graphql';
import { IsNull } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyCommand, TallyPosPlugin } from '../src';
import { COMMANDS_BODY_MAX_BYTES } from '../src/plugin';
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
  const { server, adminClient, variantIds, serviceIds, decode, encode } = environment;
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

  it('a per-command rejection does not stop the batch; the replay repeats each answer (medusapos parity)', async () => {
    // quantity 0 is an unstored invalid_payload; a tender below the total is a stored underpaid rejection.
    const invalid = orderCommand([{ variantId: variantIds.mug[0], quantity: 0, unitPriceMinor: 800 }]);
    const underpaid = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], [{ method: 'cash', amountMinor: 400 }]);
    const [valid, valid2] = [mug(), mug()];
    const commands = [valid, invalid, underpaid, valid2];
    const response = await post({ commands });
    expect(response.status).toBe(200);
    const results = response.body.results;
    expect(results.map((result: { id: string; status: string; error?: { code: string } }) => [result.id, result.status, result.error?.code]))
      .toEqual([[valid.id, 'applied', undefined], [invalid.id, 'rejected', 'invalid_payload'], [underpaid.id, 'rejected', 'underpaid'],
        [valid2.id, 'applied', undefined]]);
    expect(await ledgerFor(invalid)).toBeNull();
    expect(await ledgerFor(underpaid)).toMatchObject({ status: 'rejected' });
    const replay = await post({ commands });
    expect(replay.status).toBe(200);
    expect(replay.body.results).toEqual([
      { ...results[0], status: 'duplicate' }, results[1], results[2], { ...results[3], status: 'duplicate' },
    ]);
    expect(await ordersFor(underpaid)).toHaveLength(0);
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

  it('validates the whole batch first: at least one well-formed envelope, else 400 invalid_payload and nothing runs', async () => {
    const valid = mug();
    const cases: unknown[] = [
      {}, { commands: 'x' }, { commands: [] },
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

  it('answers 413 batch_too_large with maxCommands for more than 50 commands, and nothing runs (ruling 18)', async () => {
    const before = await ledgerCount();
    const commands = Array.from({ length: 51 }, () => mug());
    expect(await post({ commands })).toEqual({
      status: 413, body: { code: 'batch_too_large', maxCommands: 50, message: 'At most 50 commands are allowed' },
    });
    expect(await ledgerCount()).toBe(before);
  });

  // A JSON body of exactly `bytes` bytes: the value plus ASCII padding.
  function sized(value: object, bytes: number) {
    const body = JSON.stringify({ ...value, padding: '' });
    return body.replace('"padding":""', `"padding":"${'x'.repeat(bytes - body.length)}"`);
  }
  const bodyTooLarge = {
    status: 413, body: { code: 'body_too_large', maxBytes: 1_048_576, message: 'The request body exceeds 1048576 bytes' },
  };

  it('accepts a body above Vendure\'s 100 kB default and refuses one above 1 MiB with 413 body_too_large (ruling 20)', async () => {
    const input = mug();
    const large = await post({ commands: [input], padding: 'x'.repeat(200_000) });
    expect(large.status).toBe(200);
    expect(large.body.results[0]).toMatchObject({ id: input.id, status: 'applied' });
    // The parser's limit and the answer's maxBytes are the same number: the limit itself passes, one byte more is refused.
    expect(COMMANDS_BODY_MAX_BYTES).toBe(1_048_576);
    const atLimit = await post(sized({ commands: [mug()] }, COMMANDS_BODY_MAX_BYTES));
    expect(atLimit.status).not.toBe(413);
    const before = await ledgerCount();
    expect(await post(sized({ commands: [mug()] }, COMMANDS_BODY_MAX_BYTES + 1))).toEqual(bodyTooLarge);
    expect(await ledgerCount()).toBe(before);
    // Malformed JSON is the client's fault too, never a 500 the outbox would retry.
    expect(await post('{"commands": [')).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
  });

  it('refuses a chunked body over the limit (no Content-Length) with the same 413 body_too_large', async () => {
    const bytes = new TextEncoder().encode(sized({ commands: [mug()] }, COMMANDS_BODY_MAX_BYTES + 1));
    // A stream body has no known length, so fetch sends it with Transfer-Encoding: chunked.
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < bytes.length; i += 64 * 1024) controller.enqueue(bytes.subarray(i, i + 64 * 1024));
      controller.close();
    } });
    const before = await ledgerCount();
    const response = await fetch(`${base}/tally/v1/commands`, { method: 'POST', headers: headers(), body, duplex: 'half' } as RequestInit);
    expect({ status: response.status, body: await response.json() }).toEqual(bodyTooLarge);
    expect(await ledgerCount()).toBe(before);
  });

  it('answers 200 for 50 commands in a body just under the limit: a full batch fits', async () => {
    const commands = Array.from({ length: 50 }, () => mug());
    const response = await post(sized({ commands }, COMMANDS_BODY_MAX_BYTES - 1));
    expect(response.status).toBe(200);
    expect(response.body.results.map((result: { id: string; status: string }) => [result.id, result.status]))
      .toEqual(commands.map(command => [command.id, 'applied']));
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

  it('409 after a committed command: the earlier command stays applied, and the retry replays it as duplicate (medusapos parity)', async () => {
    // pre and post sell another variant: the gated held sale keeps the mug's stock rows locked (ruling 5).
    const beans = () => orderCommand([{ variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500 }]);
    const [pre, held, post3] = [beans(), mug(), beans()];
    const barrier = gate();
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage === 'addItemToOrder' && order.customFields.tallyClientOrderId === held.payload.clientOrderId) await barrier.hold();
    };
    const first = post({ commands: [held] });
    await barrier.reached;
    const second = await post({ commands: [pre, held, post3] });
    barrier.release();
    expect(second).toEqual({ status: 409, body: { code: 'in_progress', id: held.id } });
    expect(await ledgerFor(pre)).toMatchObject({ status: 'applied' });
    expect(await ledgerFor(post3)).toBeNull();
    expect((await first).body.results[0]).toMatchObject({ status: 'applied' });
    const retry = await post({ commands: [pre, held, post3] });
    expect(retry.status).toBe(200);
    expect(retry.body.results.map((result: { id: string; status: string }) => [result.id, result.status]))
      .toEqual([[pre.id, 'duplicate'], [held.id, 'duplicate'], [post3.id, 'applied']]);
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
    async function tokenWith(permission: 'CreateOrder' | 'ReadOrder', channelIds = [activeChannel.id]) {
      const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
        createRole(input: $input) { id }
      }`), { input: { code: `till-${permission}-${randomUUID()}`, description: permission, permissions: [permission], channelIds } });
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

    // Review #32, the re-assign path: tally-pos still exists but is unassigned from the till's channel. Vendure refuses to
    // unassign from the default channel, so a second channel (as channels.e2e.ts makes it) with the Mug and the stock location.
    const { zones, stockLocations } = await adminClient.query<{
      zones: { items: Array<{ id: string; name: string }> }; stockLocations: { items: Array<{ id: string }> };
    }>(parse('query { zones { items { id name } } stockLocations { items { id } } }'));
    const denmark = zones.items.find(zone => zone.name === 'Denmark')!.id;
    const { createChannel: second } = await adminClient.query<{ createChannel: { id: string; token: string } }>(parse(`
      mutation Channel($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id token } } }`), { input: {
      code: 'vp4-least-privilege', token: 'vp4-least-privilege-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'], defaultTaxZoneId: denmark, defaultShippingZoneId: denmark,
    } });
    await adminClient.query(parse(`mutation Assign($input: AssignProductVariantsToChannelInput!) {
      assignProductVariantsToChannel(input: $input) { id }
    }`), { input: { productVariantIds: [variantIds.mug[0]], channelId: second.id } });
    await adminClient.query(parse(`mutation Assign($input: AssignStockLocationsToChannelInput!) {
      assignStockLocationsToChannel(input: $input) { id }
    }`), { input: { stockLocationIds: stockLocations.items.map(location => location.id), channelId: second.id } });
    const paymentMethods = async () => (await connection.rawConnection.getRepository(PaymentMethod).find({
      where: { code: 'tally-pos' }, relations: ['channels'],
    })).map(method => ({ id: String(method.id), channels: method.channels.map(channel => String(channel.id)).sort() }));
    const channels = [decode(activeChannel.id), decode(second.id)].sort();
    const [method] = await paymentMethods();
    // Assigned to the second channel by an admin, then unassigned, so the till's sale finds it existing but unassigned.
    await adminClient.query(parse(`mutation Assign($input: AssignPaymentMethodsToChannelInput!) {
      assignPaymentMethodsToChannel(input: $input) { id }
    }`), { input: { paymentMethodIds: [encode(method.id)], channelId: second.id } });
    expect(await paymentMethods()).toEqual([{ id: method.id, channels }]);
    await adminClient.query(parse(`mutation Remove($input: RemovePaymentMethodsFromChannelInput!) {
      removePaymentMethodsFromChannel(input: $input) { id }
    }`), { input: { paymentMethodIds: [encode(method.id)], channelId: second.id } });
    expect(await paymentMethods()).toEqual([{ id: method.id, channels: [decode(activeChannel.id)] }]);
    const secondTill = { ...await tokenWith('CreateOrder', [activeChannel.id, second.id]), 'vendure-token': second.token };
    const reassigned = mug();
    const reassign = await post({ commands: [reassigned] }, secondTill);
    expect(reassign.status).toBe(200);
    expect(reassign.body.results[0]).toMatchObject({ id: reassigned.id, status: 'applied' });
    // Assigned again by ChannelService.assignToChannels under the CreateOrder-only till, and no new payment method row.
    expect(await paymentMethods()).toEqual([{ id: method.id, channels }]);
  });
});
