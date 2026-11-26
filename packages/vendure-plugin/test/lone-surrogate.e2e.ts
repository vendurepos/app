import { randomUUID } from 'node:crypto';
import { Payment, Refund, RequestContextService, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RegisterService, TallyCommand } from '../src';
import type { RegisterEnvelope } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import { RefundService } from '../src/service/refund.service';
import { jsonbOf } from '../src/service/sql-json';
import type { CommandResult, OrderRefundEnvelope } from '../src/vendored/commands';
import { commandFingerprint } from '../src/vendored/fingerprint';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type ReadOrder = { id: string; lines: Array<{ id: string; quantity: number; proratedLinePriceWithTax: number }> };
type Session = { registerId: string; sessionId: string };
type Range = { from: string; to: string; timezone: string };

const HOUR = 3_600_000;
// The 6 characters JSON.stringify writes for a lone high surrogate, and the 6 characters jsonbOf reads it as.
const ESCAPE = String.raw`\ud83d`;

/**
 * #515: JSON.stringify keeps a lone UTF-16 surrogate as the escape \ud83d, which Postgres jsonb refuses.
 * L1–L6: a command carrying one is refused after the replay read (U+0000 still before any database access), so a
 * command recorded before #515 still replays its recorded answer (ADR 0002 §2); a valid pair is applied.
 * S1–S7: a stored one never 500s a read. Since L1–L3 refuse these strings, the S rows write the stored text directly in
 * raw SQL, as a row written before #515 (or by a foreign writer) holds it.
 * S5 (a rejected ledger row and an approval by closureId) is in register-approval.e2e.ts, whose plugin option it needs.
 */
describe('#515: lone surrogates', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode, run } = environment;
  let base: string;
  let connection: TransactionalConnection;
  let session: Session;
  let range: Range;
  let order: ReadOrder;
  let sale: CommandResult;
  let refundCommand: OrderRefundEnvelope;
  let refundResult: CommandResult;
  let replayBefore: CommandResult;
  const before: Record<string, unknown> = {};

  const admin = () => ({ Authorization: `Bearer ${adminClient.getAuthToken()}` });
  async function post(command: unknown): Promise<CommandResult> {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...admin() },
      body: JSON.stringify({ commands: [command] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).results[0];
  }
  async function get(path: string, params: Record<string, string> = {}) {
    const query = Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const response = await fetch(`${base}/tally/v1/${path}${query}`, { headers: admin() });
    return { status: response.status, body: await response.json() };
  }
  async function readOrder(id: string): Promise<ReadOrder> {
    const { order } = await adminClient.query<{ order: ReadOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      id lines { id quantity proratedLinePriceWithTax } } }`), { id });
    return order;
  }
  const envelope = (type: string, payload: Record<string, unknown>) => ({
    id: randomUUID(), type, version: 1, createdAt: new Date().toISOString(), deviceId: 'surrogate-till', attempt: 1, payload,
  });
  function refundOf(target: ReadOrder, quantity: number, cashierRef: string): OrderRefundEnvelope {
    const line = target.lines[0];
    const createdAt = new Date().toISOString();
    return { id: randomUUID(), type: 'order.refund', version: 1, createdAt, deviceId: 'surrogate-till', attempt: 1, payload: {
      clientRefundId: randomUUID(), orderId: target.id, ...session, cashierRef, createdAt,
      lines: [{ orderLineId: line.id, quantity, restock: true }], shippingMinor: 0, adjustmentMinor: 0,
      destination: 'original_method', reason: 'Returned at till', totalMinor: Math.round(quantity * line.proratedLinePriceWithTax / line.quantity),
    } } as OrderRefundEnvelope;
  }
  // Two units of the mug on one external tender carrying a reference, so one unit is left after the refund (S4).
  function saleCommand(at: string, title?: string) {
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800, ...(title ? { title } : {}) }]);
    command.createdAt = command.payload.createdAt = at;
    command.payload.registerId = session.registerId;
    command.payload.payments = [{ clientPaymentId: randomUUID(), method: 'external', reference: 'card-1', amountMinor: command.payload.totalMinor }];
    return command;
  }
  const reports = ['reports/sales', 'reports/sales/v2', 'reports/sales/v3', 'reports/sales/v4'];
  async function read(path: string, params: Record<string, string> = {}) {
    const { status, body } = await get(path, { ...range, ...params });
    expect(status, `${path} ${JSON.stringify(params)} ${JSON.stringify(body)}`).toBe(200);
    return body;
  }
  // Every read S1–S3 compare: each report version with no filter and with the register, v2–v4 with cashier-x, and the register.
  async function readAll() {
    const all: Record<string, unknown> = {};
    for (const path of reports) {
      all[path] = await read(path);
      all[`${path} register`] = await read(path, { registerId: session.registerId });
    }
    all.register = (await get(`registers/${session.registerId}`)).body;
    return all;
  }
  const storedText = async (entity: typeof Refund | typeof Payment, id: string) => (await connection.rawConnection.query(
    `SELECT "metadata" FROM "${connection.rawConnection.getRepository(entity).metadata.tableName}" WHERE "id" = $1`, [id]))[0].metadata as string;
  // Writes the stored text directly: the envelope now refuses this string, and JSON.stringify writes its escape.
  async function rewrite(entity: typeof Refund | typeof Payment, id: string, edit: (metadata: Record<string, any>) => void) {
    const metadata = JSON.parse(await storedText(entity, id));
    edit(metadata);
    await connection.rawConnection.query(
      `UPDATE "${connection.rawConnection.getRepository(entity).metadata.tableName}" SET "metadata" = $1 WHERE "id" = $2`, [JSON.stringify(metadata), id]);
    expect(await storedText(entity, id)).toContain(ESCAPE);
  }

  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    base = await server.app.getUrl();
    connection = server.app.get(TransactionalConnection);
    session = { registerId: randomUUID(), sessionId: randomUUID() };
    expect(await post(envelope('register.session.open', { ...session, openedAt: new Date().toISOString(), countedFloatMinor: 0 })))
      .toMatchObject({ status: 'applied' });
    const now = Date.now();
    range = { from: new Date(now - 2 * HOUR).toISOString(), to: new Date(now + HOUR).toISOString(), timezone: 'UTC' };
    sale = await post(saleCommand(new Date(now - HOUR).toISOString()));
    expect(sale, JSON.stringify(sale)).toMatchObject({ status: 'applied' });
    order = await readOrder(sale.serverRefs!.orderId);
    refundCommand = refundOf(order, 1, 'cashier-x');
    refundResult = await post(refundCommand);
    expect(refundResult, JSON.stringify(refundResult)).toMatchObject({ status: 'applied' });
    replayBefore = await post(refundCommand);
    expect(replayBefore).toEqual({ ...refundResult, status: 'duplicate' });
    Object.assign(before, await readAll());
    for (const path of reports.slice(1)) before[`${path} cashier-x`] = await read(path, { cashierId: 'cashier-x' });
  });
  afterAll(() => server.destroy());

  const refundId = () => decode(refundResult.refund!.refunds[0].id);
  const paymentId = async () => String((await connection.rawConnection.getRepository(Payment)
    .find({ where: { order: { id: decode(order.id) } } }))[0].id);
  // S1's rewrite, for a row run on its own (S3, S4); a no-op once S1 has run.
  async function rewriteRefund() {
    if ((await storedText(Refund, refundId())).includes(ESCAPE)) return;
    await rewrite(Refund, refundId(), metadata => {
      expect(metadata.tallyCashierRef).toBe('cashier-x');
      metadata.tallyCashierRef = '\ud83d';
    });
  }

  it('S1: a stored refund cashierRef holding \\ud83d: v1–v4 answer 200 as before, and the cashier filter reads it as U+FFFD', async () => {
    for (const path of reports.slice(1)) expect((before[`${path} cashier-x`] as { refunds: { count: number } }).refunds.count, path).toBe(1);
    await rewriteRefund();
    const after = await readAll();
    for (const path of reports) {
      expect(after[path], path).toEqual(before[path]);
      expect(after[`${path} register`], `${path} register`).toEqual(before[`${path} register`]);
    }
    for (const path of reports.slice(1)) {
      const { cashierId, ...cashier } = await read(path, { cashierId: 'cashier-x' });
      const { cashierId: nobodyId, ...nobody } = await read(path, { cashierId: 'nobody' });
      expect([cashierId, nobodyId]).toEqual(['cashier-x', 'nobody']);
      expect(cashier.refunds.count, path).toBe(0);
      expect(cashier, path).toEqual(nobody);
      expect((await read(path, { cashierId: '�' })).refunds, path)
        .toEqual((before[`${path} cashier-x`] as { refunds: unknown }).refunds);
    }
  });

  // S2's rewrite, for a row run on its own (S7); a no-op once S2 has run. Written directly: the envelope now refuses this reference.
  async function rewritePayment() {
    if ((await storedText(Payment, await paymentId())).includes(ESCAPE)) return;
    await rewrite(Payment, await paymentId(), metadata => {
      expect(metadata.tender).toMatchObject({ method: 'external', reference: 'card-1' });
      metadata.tender.reference = 'card \ud83d';
    });
  }

  it('S2: the sale\'s stored tender reference holding \\ud83d: v1–v4 answer 200 as before', async () => {
    await rewritePayment();
    const after = await readAll();
    for (const path of reports) {
      expect(after[path], path).toEqual(before[path]);
      expect(after[`${path} register`], `${path} register`).toEqual(before[`${path} register`]);
    }
  });

  it('S7: S1\'s refund without tallyMethod reads its method through the sale\'s stored tender, escape and all: v1–v4 as before', async () => {
    await rewriteRefund();
    await rewritePayment();
    // A dashboard refund has no tallyMethod, so REFUND_METHOD falls to payment.metadata, whose reference holds the escape (S2).
    await rewrite(Refund, refundId(), metadata => {
      expect(metadata.tallyMethod).toBe('external');
      delete metadata.tallyMethod;
    });
    try {
      for (const path of reports) {
        expect(await read(path), path).toEqual(before[path]);
        expect(await read(path, { registerId: session.registerId }), `${path} register`).toEqual(before[`${path} register`]);
      }
    } finally {
      // The session read (S3) counts the refund by its tallyMethod, so later rows see it as S1 left it.
      await rewrite(Refund, refundId(), metadata => { metadata.tallyMethod = 'external'; });
    }
  });

  it('S3: the register session holding S1\'s refund reads as before (register.service sessionRefunds)', async () => {
    await rewriteRefund();
    const { status, body } = await get(`registers/${session.registerId}`);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.session).toMatchObject({ id: session.sessionId, expected: expect.any(Object) });
    expect(body).toEqual(before.register);
  });

  it('S4: a new order.refund on S1\'s order applies over the stored escape, and S1\'s original refund replays as before', async () => {
    await rewriteRefund();
    const next = refundOf(order, 1, 'cashier-y');
    expect(await post(next)).toMatchObject({ id: next.id, status: 'applied', refund: { totalMinor: next.payload.totalMinor } });
    expect(await post(refundCommand)).toEqual(replayBefore);
  });

  describe('S6: jsonbOf reads every real surrogate escape as U+FFFD, and nothing else', () => {
    const value = async (text: string) => (await connection.rawConnection.query(`SELECT ${jsonbOf('$1')} ->> 'k' AS k`, [text]))[0].k as string;

    it.each([
      [String.raw`{"k":"a\ud83d"}`, 'a�'],
      [String.raw`{"k":"\udc00"}`, '�'],
      [String.raw`{"k":"\ud83d\ud83d"}`, '��'],
      [String.raw`{"k":"\\ud83d"}`, String.raw`\ud83d`],
      [String.raw`{"k":"\\\ud83d"}`, '\\�'],
      ['{"k":"😀"}', '😀'],
      ['{"k":"plain"}', 'plain'],
    ])('S6: %s reads as %j', async (text, expected) => {
      expect(await value(text)).toBe(expected);
    });

    it('S6: the pattern is an escape-string literal: with standard_conforming_strings off, a\\ud83d still reads as a�', async () => {
      const runner = connection.rawConnection.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query('SET LOCAL standard_conforming_strings = off');
        expect((await runner.query(`SHOW standard_conforming_strings`))[0].standard_conforming_strings).toBe('off');
        const [{ k }] = await runner.query(`SELECT ${jsonbOf('$1')} ->> 'k' AS k`, [String.raw`{"k":"a\ud83d"}`]);
        expect(k).toBe('a�');
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('S6: a plain cast refuses the lone escape, so the rows above test the replacement', async () => {
      await expect(connection.rawConnection.query(`SELECT CAST($1 AS jsonb) ->> 'k' AS k`, [String.raw`{"k":"a\ud83d"}`]))
        .rejects.toThrow('invalid input syntax for type json');
    });
  });

  describe('L1–L6: a lone surrogate is refused after the replay read, U+0000 before any database access', () => {
    const route = async () => markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
    const refusal = (id: string, message: string) => ({ id, status: 'rejected', error: { code: 'invalid_payload', message } });
    const counts = async () => ({
      ledger: await connection.rawConnection.getRepository(TallyCommand).count(),
      refunds: await connection.rawConnection.getRepository(Refund).count(),
    });
    // Nothing of a refused command is stored: no ledger row has its id.
    const unrecorded = async (id: string) =>
      expect(await connection.rawConnection.getRepository(TallyCommand).findOneBy({ id }), `ledger row ${id}`).toBeNull();
    // L5's U+0000 refusals run with getRepository spied on, as ledger.e2e.ts review 4: nothing reads or writes the database.
    async function untouched<T>(work: () => Promise<T>) {
      const repositories = vi.spyOn(connection, 'getRepository');
      let calls: number;
      try {
        return await work();
      } finally {
        calls = repositories.mock.calls.length;
        repositories.mockRestore();
        expect(calls, 'getRepository calls').toBe(0);
      }
    }

    it('L1: order.create with a lone high in payload.registerId, or a lone low ending a line title, is refused after the replay read; nothing stored', async () => {
      const at = new Date().toISOString();
      const register = saleCommand(at);
      register.payload.registerId = 'till\ud83d';
      const title = saleCommand(at, 'Mug \udc00');
      const stored = await counts();
      expect(await run(register)).toEqual(refusal(register.id, 'payload.registerId: must not contain a lone surrogate'));
      expect(await run(title)).toEqual(refusal(title.id, 'payload.lines.0.title: must not contain a lone surrogate'));
      expect(await counts()).toEqual(stored);
      await unrecorded(register.id);
      await unrecorded(title.id);
    });

    it('L2: order.refund with payload.cashierRef a lone high is refused after the replay read; nothing stored', async () => {
      const command = refundOf(order, 1, '\ud83d');
      const stored = await counts();
      const ctx = await route();
      expect(await server.app.get(RefundService).apply(ctx, command as never))
        .toEqual(refusal(command.id, 'payload.cashierRef: must not contain a lone surrogate'));
      expect(await post(command)).toEqual(refusal(command.id, 'payload.cashierRef: must not contain a lone surrogate'));
      expect(await counts()).toEqual(stored);
      await unrecorded(command.id);
    });

    it('L3: a register command with a lone surrogate in payload.registerId is refused after the replay read; nothing stored', async () => {
      const command = envelope('register.session.open', {
        registerId: 'reg\ud83d', sessionId: randomUUID(), openedAt: new Date().toISOString(), countedFloatMinor: 0,
      }) as RegisterEnvelope;
      const stored = await counts();
      const ctx = await route();
      expect(await server.app.get(RegisterService).apply(ctx, command))
        .toEqual(refusal(command.id, 'payload.registerId: must not contain a lone surrogate'));
      expect(await post(command)).toEqual(refusal(command.id, 'payload.registerId: must not contain a lone surrogate'));
      expect(await counts()).toEqual(stored);
      await unrecorded(command.id);
    });

    it('L5: a string holding both U+0000 and a lone surrogate is refused with the U+0000 message, unchanged', async () => {
      const create = saleCommand(new Date().toISOString());
      create.payload.registerId = 'till\u0000\ud83d';
      const refund = refundOf(order, 1, '\ud83d\u0000');
      const register = envelope('register.session.open', {
        registerId: '\u0000\ud83d', sessionId: randomUUID(), openedAt: new Date().toISOString(), countedFloatMinor: 0,
      }) as RegisterEnvelope;
      const ctx = await route();
      expect(await untouched(() => run(create))).toEqual(refusal(create.id, 'payload.registerId: must not contain U+0000'));
      expect(await untouched(() => server.app.get(RefundService).apply(ctx, refund as never)))
        .toEqual(refusal(refund.id, 'payload.cashierRef: must not contain U+0000'));
      expect(await untouched(() => server.app.get(RegisterService).apply(ctx, register)))
        .toEqual(refusal(register.id, 'payload.registerId: must not contain U+0000'));
    });

    it('L4: a valid pair is applied: order.create with the title \'Mug 😀\', and order.refund with cashierRef \'😀\'', async () => {
      const create = saleCommand(new Date().toISOString(), 'Mug 😀');
      const created = await post(create);
      expect(created, JSON.stringify(created)).toMatchObject({ id: create.id, status: 'applied' });
      const refund = refundOf(await readOrder(created.serverRefs!.orderId), 1, '😀');
      const refunded = await post(refund);
      expect(refunded).toMatchObject({ id: refund.id, status: 'applied' });
      const stored = await connection.rawConnection.getRepository(Refund).findOneByOrFail({ id: decode(refunded.refund!.refunds[0].id) });
      expect(stored.metadata.tallyCashierRef).toBe('😀');
    });

    // ADR 0002 §2: a committed command replays its recorded answer, whatever its values would now fail. A row recorded
    // before #515 for a command holding a lone surrogate cannot be written through the envelope any more, so the command
    // is applied with a placeholder string, and its ledger row's fingerprint is then set, in raw SQL, to the plugin's own
    // fingerprint of the surrogate version: the row reads as that command's, as it would have been stored before #515.
    // Replay reads only that row's channel, fingerprint, status and recorded result, never the placeholder's order or other side data.
    async function replaysRecorded<C extends { id: string; type: string; version: number; payload: unknown }>(first: C, surrogate: C) {
      expect(surrogate.id).toBe(first.id);
      const applied = await post(first);
      expect(applied, JSON.stringify(applied)).toMatchObject({ id: first.id, status: 'applied' });
      const table = connection.rawConnection.getRepository(TallyCommand).metadata.tableName;
      await connection.rawConnection.query(`UPDATE "${table}" SET "fingerprint" = $1 WHERE "id" = $2`, [commandFingerprint(surrogate), first.id]);
      expect(await post(surrogate)).toEqual({ ...applied, status: 'duplicate' });
    }

    it('L6: order.create recorded before #515 with a lone surrogate in a line title replays its recorded answer', async () => {
      const first = saleCommand(new Date().toISOString(), 'Mug x');
      const surrogate = structuredClone(first);
      surrogate.payload.lines[0].title = 'Mug \ud83d';
      await replaysRecorded(first, surrogate);
    });

    it('L6: order.refund recorded before #515 with a lone surrogate in payload.cashierRef replays its recorded answer', async () => {
      const created = await post(saleCommand(new Date().toISOString()));
      expect(created, JSON.stringify(created)).toMatchObject({ status: 'applied' });
      const first = refundOf(await readOrder(created.serverRefs!.orderId), 1, 'cashier-x');
      const surrogate = structuredClone(first);
      surrogate.payload.cashierRef = '\ud83d';
      await replaysRecorded(first, surrogate);
    });

    it('L6: register.session.open recorded before #515 with a lone surrogate in payload.registerId replays its recorded answer', async () => {
      const first = envelope('register.session.open', {
        registerId: 'till-x', sessionId: randomUUID(), openedAt: new Date().toISOString(), countedFloatMinor: 0,
      });
      const surrogate = structuredClone(first);
      surrogate.payload.registerId = 'till-\ud83d';
      await replaysRecorded(first, surrogate);
    });
  });
});
