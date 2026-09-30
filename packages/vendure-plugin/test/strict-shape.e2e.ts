import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyCommand } from '../src';
import { strictShapeErrors } from '../src/service/strict-shape';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type Envelope = CommandEnvelope<OrderCreatePayload>;
const v3Fixture: Envelope = JSON.parse(readFileSync(join(__dirname, 'fixtures/order-create-v3.json'), 'utf8'));
let sequence = 0;
const uuid = () => `019f6d2e-7800-7000-8000-${String(++sequence).padStart(6, '0')}${String(Date.now()).slice(-6)}`;

describe('ruling 17: order.create is validated strictly per version', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 100 }] });
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  // @tallyui/pos 2.0.0's toOrderCreateEnvelope, field for field: v1 without a discount, v2 with one, never v3.
  function tillEnvelope(options: { discountMinor?: number; customer?: { email: string } | null } = {}): Envelope {
    const discountMinor = options.discountMinor ?? 0;
    const net = 2 * 800 - discountMinor;
    const taxMinor = Math.round(net / 4);
    const createdAt = '2026-09-28T10:00:00.000Z';
    return {
      id: uuid(), type: 'order.create', version: discountMinor > 0 ? 2 : 1, createdAt, deviceId: 'till-2.0.0', attempt: 1,
      payload: {
        clientOrderId: uuid(), createdAt, currency: 'EUR', pricesIncludeTax: false,
        lines: [{
          clientLineId: uuid(), variantId: variantIds.mug[0], title: 'Mug', quantity: 2, unitPriceMinor: 800,
          taxInclusive: false, ...(discountMinor > 0 ? { discountMinor } : {}),
        }],
        payments: [{
          clientPaymentId: uuid(), method: 'cash', amountMinor: net + taxMinor,
          tenderedMinor: 5000, changeMinor: 5000 - net - taxMinor, reference: 'drawer-1',
        }],
        subtotalMinor: net, ...(discountMinor > 0 ? { discountMinor } : {}),
        taxMinor, totalMinor: net + taxMinor,
        customer: options.customer === undefined ? { email: 'strict@example.com' } : options.customer,
        registerId: 'register-1', cashierRef: 'cashier-1',
      },
    };
  }
  const ledgerCount = () => connection.rawConnection.getRepository(TallyCommand).count();
  // An unstored step-1 refusal: no database access at all, so no ledger row.
  async function expectRefused(input: Envelope, messages: string[]) {
    const before = await ledgerCount();
    const repositories = vi.spyOn(connection, 'getRepository');
    let result;
    try {
      result = await run(input);
      expect(result).toMatchObject({ id: input.id, status: 'rejected', error: { code: 'invalid_payload' } });
      for (const message of messages) expect(result.error!.message).toContain(message);
      expect(repositories).not.toHaveBeenCalled();
    } finally {
      repositories.mockRestore();
    }
    expect(await ledgerCount()).toBe(before);
    return result;
  }

  it('fixture v1: the 2.0.0 till envelope with every optional field is applied, with a customer and with customer null', async () => {
    for (const customer of [{ email: 'strict@example.com' }, null]) {
      const input = tillEnvelope({ customer });
      expect(input.version).toBe(1);
      expect(await run(input), JSON.stringify(customer)).toMatchObject({ id: input.id, status: 'applied' });
    }
  });

  it('fixture v2: the 2.0.0 till envelope with a line and an order discountMinor is applied', async () => {
    const input = tillEnvelope({ discountMinor: 100 });
    expect(input.version).toBe(2);
    expect(input.payload.lines[0].discountMinor).toBe(100);
    expect(await run(input)).toMatchObject({ id: input.id, status: 'applied' });
  });

  it('fixture v3: the vendored ADR-065 fixture has no strict-shape error, and the v3 test payload is applied', async () => {
    expect(strictShapeErrors(v3Fixture as unknown as Record<string, unknown>, 3)).toEqual([]);
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: 'v3@example.com' });
    expect(await run(input)).toMatchObject({ id: input.id, status: 'applied' });
  });

  it('v1 with a discountMinor, order-level or line-level, is an unstored invalid_payload naming the field and version', async () => {
    // First: consistent discounts (line 50, order 50) pass payloadShapeErrors, so only ruling 17 refuses this one.
    const consistent = tillEnvelope();
    consistent.payload.lines[0].discountMinor = 50;
    consistent.payload.discountMinor = 50;
    await expectRefused(consistent, [
      'discountMinor: requires order.create version 2, command is version 1',
      'lines[0].discountMinor: requires order.create version 2, command is version 1',
    ]);
    const order = tillEnvelope();
    order.payload.discountMinor = 100;
    await expectRefused(order, ['discountMinor: requires order.create version 2, command is version 1']);
    const line = tillEnvelope();
    line.payload.lines[0].discountMinor = 100;
    await expectRefused(line, ['lines[0].discountMinor: requires order.create version 2, command is version 1']);
  });

  it('an unknown field at every level is an unstored invalid_payload naming its full path', async () => {
    const cases: Array<[string, (input: Envelope & Record<string, unknown>) => void]> = [
      ['envelope.priority', input => { input.priority = 1; }],
      ['note', input => { Object.assign(input.payload, { note: 'x' }); }],
      ['lines[0].discountMinr', input => { Object.assign(input.payload.lines[0], { discountMinr: 100 }); }],
      ['payments[0].tip', input => { Object.assign(input.payload.payments[0], { tip: 50 }); }],
      ['customer.phone', input => { Object.assign(input.payload.customer!, { phone: '555' }); }],
    ];
    for (const [path, mutate] of cases) {
      for (const discountMinor of [0, 100]) {
        const input = tillEnvelope({ discountMinor }) as Envelope & Record<string, unknown>;
        mutate(input);
        await expectRefused(input, [`${path}: unknown field in order.create version ${input.version}`]);
      }
    }
    const v3 = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    Object.assign(v3.payload.display!.lines[0], { extra: true });
    await expectRefused(v3, ['display.lines[0].extra: unknown field in order.create version 3']);
  });

  it('v3 fields in v1 or v2 are an unstored invalid_payload naming the version they require', async () => {
    const v3 = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: 'v3@example.com' });
    for (const field of ['sessionId', 'display', 'taxByRate'] as const) {
      for (const discountMinor of [0, 100]) {
        const input = tillEnvelope({ discountMinor });
        Object.assign(input.payload, { [field]: v3.payload[field] });
        await expectRefused(input, [`${field}: requires order.create version 3, command is version ${input.version}`]);
      }
    }
    const input = tillEnvelope();
    Object.assign(input.payload.customer!, { customerId: 'cus_1' });
    await expectRefused(input, ['customer.customerId: requires order.create version 3, command is version 1']);
  });

  it('ruling 19: payload.locationId is an unstored invalid_payload in any version, until a ruling says how it is honoured', async () => {
    const v3 = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: 'v3@example.com' });
    for (const input of [tillEnvelope(), v3]) {
      input.payload.locationId = 'T_1';
      const result = await expectRefused(input, []);
      expect(result.error, `v${input.version}`).toEqual({ code: 'invalid_payload', message: 'payload.locationId: not supported by this server yet' });
    }
  });

  it('replay is unaffected: an applied command resent unchanged is a duplicate', async () => {
    const input = tillEnvelope();
    const applied = await run(input);
    expect(applied).toMatchObject({ status: 'applied' });
    expect(await run(structuredClone(input))).toMatchObject({ id: input.id, status: 'duplicate', serverRefs: applied.serverRefs });
  });
});
