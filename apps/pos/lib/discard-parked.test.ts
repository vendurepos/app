import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import type { RxCollection } from 'rxdb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { discardParkedSale, PARKED_HOLDS_PAYMENT, PARKED_UNREADABLE } from './discard-parked';
import { openOrderStore, orderDrafts } from './orders-db';

// Memory storage stands in for SQLite, as in orders-db.test.ts.
vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));

let store: Awaited<ReturnType<typeof openOrderStore>>;
let drafts: RxCollection;
let n = 0;

beforeEach(async () => {
  store = await openOrderStore(`discard_parked_${n++}`, 'web');
  drafts = orderDrafts(store.orders)!;
});
afterEach(async () => { await store.close(); });

/** A parked draft as writeOrderDraft writes it, with `data` given as is (a snapshot holding `payments`, or not). */
async function park(data: string): Promise<string> {
  await drafts.insert({ id: 'draft-1', data, customerName: '', itemCount: 1, total: 952, parkedAt: '2026-11-25T10:00:00.000Z' });
  return 'draft-1';
}
const snapshot = (payments?: unknown) =>
  JSON.stringify({ id: 'draft-1', currency: 'EUR', lineItems: [{ id: 'l1', name: 'Mug' }], totalMinor: 952, ...(payments === undefined ? {} : { payments }) });
const leg = (extra: Record<string, unknown>) => ({ id: `leg-${JSON.stringify(extra)}`, method: 'cash', amountMinor: 500, ...extra });
const taken = { takenAt: '2026-11-25T10:00:00.000Z', sessionId: 'session-1' };

async function expectRefused(data: string, message: string) {
  const id = await park(data);
  await expect(discardParkedSale(drafts, id)).rejects.toThrow(message);
  expect((await drafts.findOne(id).exec())?.get('data')).toBe(data);
}
async function expectDiscarded(data: string) {
  const id = await park(data);
  await discardParkedSale(drafts, id);
  expect(await drafts.findOne(id).exec()).toBeNull();
}

it('discards a parked sale with no payments', async () => {
  await expectDiscarded(snapshot([]));
});

it('refuses a captured leg, status absent counting as captured', async () => {
  await expectRefused(snapshot([leg({ ...taken })]), PARKED_HOLDS_PAYMENT);
});

it('refuses a captured leg an older build wrote with no takenAt and no sessionId', async () => {
  await expectRefused(snapshot([leg({ status: 'captured' })]), PARKED_HOLDS_PAYMENT);
});

it.each(['pending', 'authorized'])('refuses a leg that is %s', async (status) => {
  await expectRefused(snapshot([leg({ status, ...taken })]), PARKED_HOLDS_PAYMENT);
});

it.each(['voided', 'failed', 'cancelled'])('discards a sale whose only leg is %s', async (status) => {
  await expectDiscarded(snapshot([leg({ status, ...taken })]));
});

it("discards a reopened sale whose only legs are its locked store payments", async () => {
  await expectDiscarded(snapshot([leg({ locked: true, reopened: true }), leg({ status: 'captured', locked: true, method: 'card' })]));
});

it.each([
  ['a voided and a captured leg', [leg({ status: 'voided', ...taken }), leg({ status: 'captured', ...taken, method: 'card' })]],
  ['a locked and a captured leg', [leg({ locked: true }), leg({ status: 'captured', ...taken, method: 'card' })]],
])('refuses %s', async (_, payments) => {
  await expectRefused(snapshot(payments), PARKED_HOLDS_PAYMENT);
});

it('refuses a captured, unlocked leg marked reopened', async () => {
  await expectRefused(snapshot([leg({ status: 'captured', reopened: true })]), PARKED_HOLDS_PAYMENT);
});

it.each([
  ['data that is not JSON', '{not json'],
  ['data that is not an object', '"a string"'],
  ['data that is null', 'null'],
  ['payments that are not an array', snapshot({ 0: { status: 'captured' } })],
  ['payments that are null', snapshot(null)],
  ['a payment that is not an object', snapshot(['captured'])],
])('refuses %s, as unreadable', async (_, data) => {
  await expectRefused(data, PARKED_UNREADABLE);
});

it('discards a draft with no payments field', async () => {
  await expectDiscarded(snapshot());
});

it('resolves and removes nothing when the draft is no longer there', async () => {
  await park(snapshot([]));
  await expect(discardParkedSale(drafts, 'gone')).resolves.toBeUndefined();
  expect(await drafts.count().exec()).toBe(1);
});
