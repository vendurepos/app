import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOrderOutbox, parkedOrderSummaries$, restoreOrderDraft, type Order, type OrderOutboxOptions, type PosOrder } from '@tallyui/pos';
import { createRxDatabase, type RxJsonSchema } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { firstValueFrom } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { appStorage } from './app-storage';
import { openOrderStore, orderDrafts, ordersDatabaseName } from './orders-db';

vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));

const fixturePath = fileURLToPath(new URL('./__fixtures__/orders-db-tallyui-5.3.0.json', import.meta.url).href);
type StoredSchema = Omit<RxJsonSchema<Record<string, unknown>>, 'indexes' | 'required'> & {
  indexes: string[][]; required: string[];
};

function withoutMeta(row: object) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')));
}

function seedSchema(schema: StoredSchema) {
  return {
    ...schema,
    properties: withoutMeta(schema.properties),
    required: schema.required.filter((key) => !key.startsWith('_')),
    indexes: schema.indexes.filter(([first]) => first !== '_meta.lwt').map((index) => index.filter((key) => key !== '_deleted')),
  };
}

async function reopenFixture(channelToken: string) {
  const fixture: {
    posOrderSchema: StoredSchema; orderDraftSchema: StoredSchema;
    posOrders: PosOrder[]; orderDrafts: { id: string; data: string }[];
  } = JSON.parse(await readFile(fixturePath, 'utf8'));
  const name = ordersDatabaseName({ url: 'http://127.0.0.1:1', channelToken });
  const seed = await createRxDatabase({
    name, multiInstance: false, storage: wrappedValidateAjvStorage({ storage: appStorage() }),
  });
  try {
    await seed.addCollections({
      pos_orders: {
        schema: seedSchema(fixture.posOrderSchema),
        autoMigrate: false,
        migrationStrategies: Object.fromEntries(Array.from({ length: 23 }, (_, index) => [index + 1, (doc: unknown) => doc])),
      },
      order_drafts: { schema: seedSchema(fixture.orderDraftSchema) },
    });
    expect(seed.pos_orders.schema.version).toBe(23);
    expect((await seed.pos_orders.bulkInsert(fixture.posOrders)).error).toEqual([]);
    expect((await seed.order_drafts.bulkInsert(fixture.orderDrafts)).error).toEqual([]);
  } finally {
    await seed.close();
  }
  return { fixture, store: await openOrderStore(name, 'web') };
}

it('keeps every 5.3.0 sale exactly as stored, queued and synced', async () => {
  const { fixture, store } = await reopenFixture('upgrade-5.3.0');
  try {
    expect(store.orders.schema.version).toBe(24);
    expect(await store.orders.count().exec()).toBe(3);
    const neverSent = fixture.posOrders.find((row) => row.note === 'Queued on 5.3.0, never sent')!;
    const sentOnce = fixture.posOrders.find((row) => row.note === 'Queued on 5.3.0, sent once')!;
    const synced = fixture.posOrders.find((row) => row.note === 'Synced on 5.3.0')!;
    for (const [expected, sentVersion] of [[neverSent, undefined], [sentOnce, 11], [synced, 7]] as const) {
      const stored = await store.orders.findOne(expected.id).exec(true);
      expect(withoutMeta(stored.toJSON())).toEqual(expected);
      expect(stored.commandId).toBe(expected.commandId);
      expect(stored.sentVersion).toBe(sentVersion);
      if (expected === synced) {
        expect(stored.syncStatus).toBe('applied');
        expect(stored.serverRefs).toEqual({ orderId: '301', displayId: 'POS-301', totalMinor: 1309 });
      }
    }
    const pending = await store.orders.find({ selector: { syncStatus: 'pending' } }).exec();
    expect(pending.map((doc) => doc.id).sort()).toEqual([neverSent.id, sentOnce.id].sort());
  } finally {
    await store.close();
  }
});

it('sends only the two queued 5.3.0 sales after the upgrade, never the synced one', async () => {
  const { fixture, store } = await reopenFixture('upgrade-5.3.0-outbox');
  const send = vi.fn<OrderOutboxOptions['transport']['send']>(async (batch) => ({
    kind: 'results', results: batch.map(({ id, payload }, index) => ({
      id, status: 'applied', serverRefs: { orderId: `40${index}`, totalMinor: payload.totalMinor },
    })),
  }));
  const outbox = createOrderOutbox({ collection: store.orders, transport: { send }, deviceId: 'device-561', getMaxOrderCreateVersion: () => 11 });
  try {
    await outbox.flush();
    const sent = send.mock.calls.flatMap(([batch]) => batch.map(({ id, payload }) => ({ id, totalMinor: payload.totalMinor })));
    const queued = ['Queued on 5.3.0, never sent', 'Queued on 5.3.0, sent once'].map((note) => fixture.posOrders.find((row) => row.note === note)!);
    expect(sent).toHaveLength(2);
    for (const row of queued) expect(sent).toContainEqual({ id: row.commandId, totalMinor: 1309 });
    const synced = fixture.posOrders.find((row) => row.note === 'Synced on 5.3.0')!;
    expect(sent.map(({ id }) => id)).not.toContain(synced.commandId);
    expect((await store.orders.findOne(synced.id).exec(true)).serverRefs?.orderId).toBe('301');
    expect(await store.orders.find({ selector: { syncStatus: 'pending' } }).exec()).toEqual([]);
  } finally {
    outbox.stop();
    await store.close();
  }
});

it('keeps the 5.3.0 parked cart and restores it to the same total', async () => {
  const { fixture, store } = await reopenFixture('upgrade-5.3.0-parked');
  try {
    const expected = fixture.orderDrafts.find((row) => JSON.parse(row.data).note === 'Parked on 5.3.0')!;
    const drafts = orderDrafts(store.orders)!;
    const draft = await drafts.findOne(expected.id).exec(true);
    expect(withoutMeta(draft.toJSON())).toEqual(expected);
    const summaries = await firstValueFrom(parkedOrderSummaries$(drafts));
    expect(summaries.map(({ id }) => id).sort()).toEqual(fixture.orderDrafts.map(({ id }) => id).sort());
    expect(summaries.find(({ id }) => id === expected.id)).toMatchObject({ customerName: 'Ada Park', itemCount: 1, totalMinor: 1904, source: 'local' });
    const saved: Order = JSON.parse(draft.data);
    const taxContext = { getTaxRatePpm: () => 190000, pricesIncludeTax: false };
    const restored = restoreOrderDraft(saved, { currency: 'EUR', taxContext }).getSnapshot();
    expect(restored.totalMinor).toBe(saved.totalMinor);
    expect(restored.totalMinor).toBe(1904);
    expect(restored.taxMinor).toBe(saved.taxMinor);
    expect(restored.lineItems.map(({ variantId, quantity }) => [variantId, quantity]))
      .toEqual(saved.lineItems.map(({ variantId, quantity }) => [variantId, quantity]));
    expect(restored.customer?.id).toBe('7');
    expect(restored.note).toBe('Parked on 5.3.0');
  } finally {
    await store.close();
  }
});

it('keeps the part-paid 5.3.0 parked cart and its cash leg', async () => {
  const { fixture, store } = await reopenFixture('upgrade-5.3.0-part-paid');
  try {
    const expected = fixture.orderDrafts.find((row) => JSON.parse(row.data).note === 'Parked part paid on 5.3.0')!;
    const drafts = orderDrafts(store.orders)!;
    const draft = await drafts.findOne(expected.id).exec(true);
    expect(withoutMeta(draft.toJSON())).toEqual(expected);
    const summaries = await firstValueFrom(parkedOrderSummaries$(drafts));
    expect(summaries.map(({ id }) => id).sort()).toEqual(fixture.orderDrafts.map(({ id }) => id).sort());
    const summary = summaries.find(({ id }) => id === expected.id);
    expect(summary).toMatchObject({ itemCount: 1, totalMinor: 1428, source: 'local' });
    expect(summary?.customerName).toBeUndefined();
    const saved: Order = JSON.parse(draft.data);
    const taxContext = { getTaxRatePpm: () => 190000, pricesIncludeTax: false };
    const restored = restoreOrderDraft(saved, { currency: 'EUR', taxContext }).getSnapshot();
    expect(restored.totalMinor).toBe(1428);
    expect(restored.payments).toMatchObject([{
      id: saved.payments[0].id, method: 'cash', amountMinor: 500, tenderedMinor: 500, takenAt: '2026-11-28T08:00:00.000Z',
    }]);
    expect(restored.paidMinor).toBe(500);
    expect(restored.balanceDueMinor).toBe(928);
  } finally {
    await store.close();
  }
});
