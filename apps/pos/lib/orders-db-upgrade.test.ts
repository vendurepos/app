import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parkedOrderSummaries$, restoreOrderDraft, type Order, type PosOrder } from '@tallyui/pos';
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

it('keeps every queued 5.3.0 sale exactly as stored', async () => {
  const { fixture, store } = await reopenFixture('upgrade-5.3.0');
  try {
    expect(store.orders.schema.version).toBe(24);
    expect(await store.orders.count().exec()).toBe(2);
    const [cash, external] = fixture.posOrders;
    for (const [expected, sentVersion] of [[cash, undefined], [external, 11]] as const) {
      const stored = await store.orders.findOne(expected.id).exec(true);
      expect(withoutMeta(stored.toJSON())).toEqual(expected);
      expect(stored.commandId).toBe(expected.commandId);
      expect(stored.sentVersion).toBe(sentVersion);
    }
    const pending = await store.orders.find({ selector: { syncStatus: 'pending' } }).exec();
    expect(pending.map((doc) => doc.id).sort()).toEqual(fixture.posOrders.map((doc) => doc.id));
  } finally {
    await store.close();
  }
});

it('keeps the 5.3.0 parked cart and restores it to the same total', async () => {
  const { fixture, store } = await reopenFixture('upgrade-5.3.0-parked');
  try {
    const [expected] = fixture.orderDrafts;
    const drafts = orderDrafts(store.orders)!;
    const draft = await drafts.findOne(expected.id).exec(true);
    expect(withoutMeta(draft.toJSON())).toEqual(expected);
    expect(await firstValueFrom(parkedOrderSummaries$(drafts))).toMatchObject([
      { id: expected.id, customerName: 'Ada Park', itemCount: 1, totalMinor: 1904, source: 'local' },
    ]);
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
