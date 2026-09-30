import type { RegisterCommandEnvelope } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder, type TransportOutcome } from '@tallyui/pos';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { expect, it, vi } from 'vitest';
import { flushOnDrain, holdClosuresForOrders, pendingSessionOrders } from './closure-hold';
import { openOrderStore } from './orders-db';

// Memory storage stands in for SQLite (as in orders-db.test.ts).
vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));

const command = (type: RegisterCommandEnvelope['type'], sessionId: string, id = `${type}:${sessionId}`) =>
  ({ id, type, version: 1, payload: { sessionId }, createdAt: '2026-09-30T17:00:00.000Z', deviceId: 'till-1', attempt: 1 }) satisfies RegisterCommandEnvelope;
const open1 = command('register.session.open', 'session-1');
const closed1 = command('register.session.transition', 'session-1');
const closure1 = command('register.closure.submit', 'session-1');
const open2 = command('register.session.open', 'session-2');
const closure2 = command('register.closure.submit', 'session-2');

/** The wrapper around a fake transport that applies every command, with `pending` orders per session. */
function held(pending: Record<string, number>) {
  const sent: string[][] = [];
  const inner = { send: vi.fn(async (batch: RegisterCommandEnvelope[]): Promise<TransportOutcome> => {
    sent.push(batch.map(({ id }) => id));
    return { kind: 'results', results: batch.map(({ id }) => ({ id, status: 'applied' })) };
  }) };
  return { sent, transport: holdClosuresForOrders(inner, async (sessionId) => pending[sessionId] ?? 0) };
}

it("holds a closure while its session's orders are pending, as a retry the outbox backs off from", async () => {
  const { sent, transport } = held({ 'session-1': 2 });
  expect(await transport.send([closure1, open2])).toEqual({ kind: 'retry', reason: 'orders_pending' });
  expect(sent).toEqual([]);
});

it('sends the closure once its session has no pending orders', async () => {
  const { sent, transport } = held({ 'session-1': 0 });
  const outcome = await transport.send([open1, closed1, closure1, open2]);
  expect(sent).toEqual([[open1.id, closed1.id, closure1.id, open2.id]]);
  expect(outcome).toMatchObject({ kind: 'results', results: [{ id: open1.id }, { id: closed1.id }, { id: closure1.id }, { id: open2.id }] });
});

it('sends the commands before a held closure, and nothing from the closure on', async () => {
  const { sent, transport } = held({ 'session-1': 1 });
  const outcome = await transport.send([open1, closed1, closure1, open2]);
  expect(sent).toEqual([[open1.id, closed1.id]]);
  // The outbox marks only these; its next batch starts at the closure.
  expect(outcome).toMatchObject({ kind: 'results', results: [{ id: open1.id }, { id: closed1.id }] });
});

it("never holds another session's closure behind this session's orders", async () => {
  const { sent, transport } = held({ 'session-1': 3 });
  await transport.send([closure2]);
  expect(sent).toEqual([[closure2.id]]);
});

it('counts only the pending orders taken in the session', async () => {
  const store = await openOrderStore('vendurepos_orders_closurehold', 'web');
  const sale = (id: string, fields: Partial<PosOrder>) => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { getTaxRatePpm: () => 190000, pricesIncludeTax: false } });
    builder.addLine({ productId: 'mug', variantId: '11', name: 'Mug', sku: 'TALLY-MUG', unitPrice: { amount: 800, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 952 });
    return { ...finalizeOrder(builder.getSnapshot(), { registerId: 'register-1', cashierRef: 'cashier' }), id, ...fields };
  };
  await store.orders.bulkInsert([
    sale('a', { sessionId: 'session-1' }), sale('b', { sessionId: 'session-1' }), sale('c', { sessionId: 'session-1', syncStatus: 'applied' }),
    sale('d', { sessionId: 'session-2' }), sale('e', {}),
  ]);
  const pending = pendingSessionOrders(store.orders);
  expect([await pending('session-1'), await pending('session-2'), await pending('session-3')]).toEqual([2, 1, 0]);
  await store.close();
});

it('flushes the register outbox each time the pending orders drop, and not when they rise or hold', () => {
  const flush = vi.fn();
  const onPending = flushOnDrain(flush);
  onPending(2);
  flush.mockClear();
  onPending(3);
  onPending(3);
  expect(flush).not.toHaveBeenCalled();
  onPending(1);
  onPending(0);
  expect(flush).toHaveBeenCalledTimes(2);
});
