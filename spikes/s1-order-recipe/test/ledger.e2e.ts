import {
  Channel, ConfigService, Order, OrderLine, Payment, PaymentMethod, ShippingMethod,
  StockMovement, TaxRate, TransactionalConnection,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderCreateService } from '../src/plugin/order-create.service';
import { TallyCommand } from '../src/plugin/tally-command.entity';
import type { CommandEnvelope, CommandResult } from '../src/vendored/commands';
import { createS1TestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('S1 ledger, batches, rejections and idempotency through HTTP and Postgres', () => {
  const environment = createS1TestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  let channel: Channel;
  let url: string;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation SetLedgerFixtures($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id enabled }
    }`), { input: [
      { id: variantIds.mug[0], stockOnHand: 100 },
      { id: variantIds.print[0], enabled: false },
    ] });
    const strategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
    for (const ids of Object.values(variantIds)) {
      ids.splice(0, ids.length, ...ids.map(id => String(strategy.decodeId(id))));
    }
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    channel = await connection.rawConnection.getRepository(Channel).findOneOrFail({
      where: { code: '__default_channel__' }, relations: ['defaultTaxZone'],
    });
    url = `${await server.app.getUrl()}/tally/v1/commands`;
  });
  afterAll(() => server.destroy());

  const command = (variantId = variantIds.mug[0]) => orderCommand([{ variantId, quantity: 1, unitPriceMinor: 800 }]);
  async function post(commands: unknown[], headers: Record<string, string> = {}) {
    const start = performance.now();
    const response = await fetch(url, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Tally-Protocol': '1',
        Authorization: `Bearer ${adminClient.getAuthToken()}`, ...headers,
      }, body: JSON.stringify({ commands }),
    });
    const body = await response.json();
    return { status: response.status, body, ms: Math.round(performance.now() - start) };
  }
  async function counts() {
    return {
      orders: await connection.rawConnection.getRepository(Order).count(),
      ledger: await connection.rawConnection.getRepository(TallyCommand).count(),
      lines: await connection.rawConnection.getRepository(OrderLine).count(),
      payments: await connection.rawConnection.getRepository(Payment).count(),
      stockMovements: await connection.rawConnection.getRepository(StockMovement).count(),
    };
  }
  const ordersFor = (input: ReturnType<typeof command>) => connection.rawConnection.getRepository(Order).count({
    where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
  });
  const ledgerFor = (input: CommandEnvelope) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id });
  const statuses = (response: Awaited<ReturnType<typeof post>>) =>
    response.body.results.map((result: CommandResult) => result.status);

  // Observe the real backend after INSERT and timeout reset, while the delay hook holds it.
  // This starts the second request only once the first owns the uncommitted ledger row.
  async function waitForClaim() {
    const start = performance.now();
    while (performance.now() - start < 5000) {
      const rows = await connection.rawConnection.query(`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'
        AND query = 'SET LOCAL lock_timeout = DEFAULT'`);
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Did not observe the delayed Postgres claim');
  }

  it('validates all envelopes before claims; malformed envelopes, payloads and versions write nothing', async () => {
    const before = await counts();
    const input = command();
    const response = await post([
      null, { ...input, attempt: 0 }, { ...input, deviceId: null },
      { ...input, type: 'wrong' }, { ...input, payload: null }, { ...input, version: 4 },
    ]);
    expect(response.status).toBe(200);
    expect(response.body.results.map((result: CommandResult) => result.error?.code)).toEqual([
      'invalid_payload', 'invalid_payload', 'invalid_payload', 'invalid_payload', 'invalid_payload', 'unsupported_version',
    ]);
    expect(await counts()).toEqual(before);
    expect((await post([])).status).toBe(400);
    expect((await post(Array(51).fill(input))).status).toBe(413);
  });

  it('proof 6: a disabled second variant is rejected and stored; first and third commands commit separately', async () => {
    const inputs = [command(), command(variantIds.print[0]), command()];
    const before = await counts();
    const response = await post(inputs);
    const orderCounts = await Promise.all(inputs.map(ordersFor));
    const ledger = await Promise.all(inputs.map(ledgerFor));
    console.log('S1-NUM', JSON.stringify({ proof: '6-business', status: response.status,
      before, after: await counts(), orderCounts, ledgerStatuses: ledger.map(row => row?.status), ms: response.ms }));
    expect(response.status).toBe(200);
    expect(statuses(response)).toEqual(['applied', 'rejected', 'applied']);
    expect(response.body.results[1].error.code).toBe('unknown_variant');
    expect(orderCounts).toEqual([1, 0, 1]);
    expect(ledger.map(row => row?.status)).toEqual(['applied', 'rejected', 'applied']);
    expect(ledger[1]!.result).toEqual(response.body.results[1]);
  });

  it('proof 6: a lock timeout on the second command stops the batch after the first commit', async () => {
    const inputs = [command(), command(), command()];
    const held = post([inputs[1]], { 'X-S1-Delay-Ms': '7000' });
    let first: Awaited<ReturnType<typeof post>>;
    try {
      await waitForClaim();
      const response = await post(inputs);
      const orderCounts = await Promise.all(inputs.map(ordersFor));
      console.log('S1-NUM', JSON.stringify({ proof: '6-lock', status: response.status,
        orderCounts, firstLedgerStatus: (await ledgerFor(inputs[0]))?.status,
        thirdLedgerRows: (await ledgerFor(inputs[2])) ? 1 : 0, ms: response.ms }));
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ code: 'in_progress', id: inputs[1].id });
      expect(orderCounts).toEqual([1, 0, 0]);
      expect((await ledgerFor(inputs[0]))?.status).toBe('applied');
      expect(await ledgerFor(inputs[2])).toBeNull();
    } finally {
      first = await held;
    }
    expect(first.status).toBe(200);
    const retry = await post(inputs);
    const retryOrderCounts = await Promise.all(inputs.map(ordersFor));
    console.log('S1-NUM', JSON.stringify({ proof: '6-retry', status: retry.status,
      statuses: statuses(retry), orderCounts: retryOrderCounts, ms: retry.ms }));
    expect(retry.status).toBe(200);
    expect(statuses(retry)).toEqual(['duplicate', 'duplicate', 'applied']);
    expect(retryOrderCounts).toEqual([1, 1, 1]);
    expect(retry.body.results[0].serverRefs).toEqual((await ledgerFor(inputs[0]))?.result?.serverRefs);
    expect(retry.body.results[1].serverRefs).toEqual(first.body.results[0].serverRefs);
  });

  it.each(['disabled', 'missing'] as const)('proof 10: %s variant stores unknown_variant and replay never runs the recipe', async kind => {
    const input = command(kind === 'disabled' ? variantIds.print[0] : '999999');
    const before = await counts();
    const create = vi.spyOn(recipe, 'create'); // Calls the real recipe and Vendure services unchanged.
    try {
      const response = await post([input]);
      const replay = await post([input]);
      const after = await counts();
      console.log('S1-NUM', JSON.stringify({ proof: `10-${kind}`, status: response.status,
        replayStatus: replay.status, before, after, recipeCalls: create.mock.calls.length,
        ms: response.ms, replayMs: replay.ms }));
      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'unknown_variant' } });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(response.body);
      expect(create).toHaveBeenCalledTimes(1);
      expect(after).toEqual({ ...before, ledger: before.ledger + 1 });
      expect(await ledgerFor(input)).toMatchObject({ status: 'rejected', result: response.body.results[0] });
    } finally {
      create.mockRestore();
    }
  });

  it('proof 10: assigned default tax zone with all its rates disabled gives pre-claim store_configuration', async () => {
    const repo = connection.rawConnection.getRepository(TaxRate);
    const rates = await repo.find({ where: { zoneId: channel.defaultTaxZone.id, enabled: true } });
    expect(rates.length).toBeGreaterThan(0);
    const before = await counts();
    const input = command();
    try {
      for (const rate of rates) await repo.update(rate.id, { enabled: false });
      const response = await post([input]);
      const after = await counts();
      console.log('S1-NUM', JSON.stringify({ proof: '10-configuration', hole: 'all default-zone tax rates disabled',
        taxZoneId: channel.defaultTaxZone.id, disabledRates: rates.length,
        status: response.status, before, after, ms: response.ms }));
      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(after).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
      expect(await ordersFor(input)).toBe(0);
    } finally {
      for (const rate of rates) await repo.update(rate.id, { enabled: true });
    }
  });

  it.each(['payment', 'shipping'] as const)('missing channel POS %s method is refused before the claim', async kind => {
    const entity = kind === 'payment' ? PaymentMethod : ShippingMethod;
    const repo = connection.rawConnection.getRepository(entity);
    const method = await repo.findOneOrFail({
      where: { code: kind === 'payment' ? 'tally-pos' : 'tally-in-store' }, relations: ['channels'],
    });
    const before = await counts();
    const input = command();
    try {
      await repo.createQueryBuilder().relation(entity, 'channels').of(method).remove(channel);
      const response = await post([input]);
      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'store_configuration' } });
      expect(await counts()).toEqual(before);
      expect(await ledgerFor(input)).toBeNull();
    } finally {
      await repo.createQueryBuilder().relation(entity, 'channels').of(method).add(channel);
    }
  });

  it('proof 11(a): a duplicate waits for a 2s transaction and returns the stored refs', async () => {
    const input = command();
    const held = post([input], { 'X-S1-Delay-Ms': '2000' });
    let first: Awaited<ReturnType<typeof post>>;
    let second: Awaited<ReturnType<typeof post>>;
    try {
      await waitForClaim();
      second = await post([input]);
    } finally {
      first = await held;
    }
    const orderCount = await ordersFor(input);
    console.log('S1-NUM', JSON.stringify({ proof: '11a', firstMs: first.ms, secondMs: second.ms,
      firstStatus: first.status, secondStatus: second.status, orderCount }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(statuses(first)).toEqual(['applied']);
    expect(statuses(second)).toEqual(['duplicate']);
    expect(second.body.results[0].serverRefs).toEqual(first.body.results[0].serverRefs);
    expect(first.ms).toBeGreaterThanOrEqual(2000);
    expect(second.ms).toBeGreaterThanOrEqual(1500);
    expect(orderCount).toBe(1);
    expect(await ledgerFor(input)).toMatchObject({ status: 'applied', result: first.body.results[0] });
  });

  it('proof 11(b): a 7s claim gives 409 after about 5s and duplicate after commit', async () => {
    const input = command();
    const held = post([input], { 'X-S1-Delay-Ms': '7000' });
    let first: Awaited<ReturnType<typeof post>>;
    let second: Awaited<ReturnType<typeof post>>;
    try {
      await waitForClaim();
      second = await post([input]);
    } finally {
      first = await held;
    }
    const retry = await post([input]);
    const orderCount = await ordersFor(input);
    console.log('S1-NUM', JSON.stringify({ proof: '11b', firstMs: first.ms, secondMs: second.ms,
      retryMs: retry.ms, firstStatus: first.status, secondStatus: second.status, retryStatus: retry.status, orderCount }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'in_progress', id: input.id });
    expect(second.ms).toBeGreaterThanOrEqual(4800);
    expect(second.ms).toBeLessThan(6500);
    expect(retry.status).toBe(200);
    expect(statuses(retry)).toEqual(['duplicate']);
    expect(retry.body.results[0].serverRefs).toEqual(first.body.results[0].serverRefs);
    expect(orderCount).toBe(1);
  });

  it('proof 11(c): requeue with a new id returns applied and existing refs without any write', async () => {
    const input = command();
    const first = await post([input]);
    expect(first.status).toBe(200);
    const before = await counts();
    const requeued = { ...input, id: command().id };
    const response = await post([requeued]);
    const after = await counts();
    console.log('S1-NUM', JSON.stringify({ proof: '11c', status: response.status, before, after, ms: response.ms }));
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toEqual({ ...first.body.results[0], id: requeued.id });
    expect(after).toEqual(before);
    expect(await ledgerFor(requeued)).toBeNull();
  });

  it('proof 11(d): the same id with a changed payload is idempotency_mismatch', async () => {
    const input = command();
    const first = await post([input]);
    expect(first.status).toBe(200);
    const before = await counts();
    const changed = { ...input, payload: { ...input.payload, cashierRef: 'different-cashier' } };
    const response = await post([changed]);
    const after = await counts();
    console.log('S1-NUM', JSON.stringify({ proof: '11d', status: response.status, before, after, ms: response.ms }));
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'idempotency_mismatch' } });
    expect(after).toEqual(before);
    expect((await ledgerFor(input))?.result).toEqual(first.body.results[0]);
  });

  it('proof 12: crash after commit returns 500; retry returns duplicate with the committed orderId', async () => {
    const input = command();
    const response = await post([input], { 'X-S1-Crash-After-Commit': '1' });
    const committed = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    });
    const retry = await post([input]);
    const orderCount = await ordersFor(input);
    console.log('S1-NUM', JSON.stringify({ proof: 12, status: response.status, retryStatus: retry.status,
      orderCount, orderId: String(committed.id), retryOrderId: retry.body.results?.[0]?.serverRefs?.orderId,
      ms: response.ms, retryMs: retry.ms }));
    expect(response.status).toBe(500);
    expect(committed.state).toBe('Delivered');
    expect(retry.status).toBe(200);
    expect(retry.body.results[0]).toMatchObject({ status: 'duplicate', serverRefs: { orderId: String(committed.id) } });
    expect(orderCount).toBe(1);
  });

  it('a transient recipe exception rolls back its claim, returns exact 503 and stops the batch', async () => {
    const inputs = [command(), command(), command()];
    recipe.testObserver = async (_stage, _ctx, order) => {
      if (order.customFields.tallyClientOrderId === inputs[1].payload.clientOrderId) {
        throw new Error('S1 injected recipe exception');
      }
    };
    try {
      const response = await post(inputs);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ code: 'transient', id: inputs[1].id, message: 'Temporary failure, retry later.' });
      expect(await Promise.all(inputs.map(ordersFor))).toEqual([1, 0, 0]);
      expect(await ledgerFor(inputs[1])).toBeNull();
      expect(await ledgerFor(inputs[2])).toBeNull();
    } finally {
      recipe.testObserver = undefined;
    }
    const retry = await post(inputs);
    expect(retry.status).toBe(200);
    expect(statuses(retry)).toEqual(['duplicate', 'applied', 'applied']);
  });
});
