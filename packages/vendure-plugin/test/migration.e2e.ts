import { RequestContextService, TransactionalConnection, runMigrations } from '@vendure/core';
import { TestServer } from '@vendure/testing';
import { describe, expect, it, vi } from 'vitest';
import { OrderCreateService, TallyPos1790648006022 } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import { createPluginTestEnvironment, dbConnectionOptions, pluginTestConfig } from './env';
import { orderCommand } from './payloads';

type Query = (sql: string) => Promise<Array<Record<string, string>>>;
const tallyColumns = async (query: Query) => (await query(
  `SELECT column_name FROM information_schema.columns WHERE table_name IN ('order', 'order_line')
   AND column_name LIKE 'customFieldsTally%' ORDER BY column_name`)).map(row => row.column_name);
const tallyIndexes = async (query: Query) => (await query(
  `SELECT indexdef FROM pg_indexes WHERE (tablename = 'order' AND indexdef LIKE '%Tally%')
   OR tablename = 'tally_command' ORDER BY indexname`)).map(row => row.indexdef);

describe('the TallyPos migration', () => {
  it('runs with synchronize: false on a Vendure database without the plugin\'s schema; the server then starts and sells', async () => {
    // Vendure's AppModule fixes the plugin set once per process, so the plugin-free schema is made by
    // synchronizing with the plugin (and seeding the catalogue), then removing every plugin artefact.
    const seeded = createPluginTestEnvironment();
    await seeded.init();
    const raw = seeded.server.app.get(TransactionalConnection).rawConnection;
    const [{ database }] = await raw.query('SELECT current_database() AS database');
    await raw.query('DROP TABLE "tally_command"');
    for (const [table, columns] of [
      ['order', ['Tallyclientorderid', 'Tallysaleat', 'Tallyregisterid', 'Tallysessionid', 'Tallycashierref', 'Tallypayments', 'Tallysnapshot']],
      ['order_line', ['Tallyunitprice', 'Tallyclientlineid', 'Tallypriceincludestax']],
    ] as const) {
      for (const column of columns) await raw.query(`ALTER TABLE "${table}" DROP COLUMN "customFields${column}"`);
    }
    const query: Query = sql => raw.query(sql);
    expect(await tallyColumns(query)).toEqual([]);
    expect(await tallyIndexes(query)).toEqual([]);
    expect(await raw.query("SELECT to_regclass('tally_command') AS ledger")).toEqual([{ ledger: null }]);
    await seeded.server.destroy();

    const config = pluginTestConfig({ dbConnectionOptions: {
      ...dbConnectionOptions, database, synchronize: false, migrations: [TallyPos1790648006022],
    } });
    // runMigrations prints "Your database schema does not match…" when the schema diff is not empty.
    const printed = vi.spyOn(console, 'log');
    try {
      expect(await runMigrations(config)).toEqual(['TallyPos1790648006022']);
      const output = printed.mock.calls.flat().join('\n');
      expect(output).toMatch(/Successfully ran migration: TallyPos1790648006022/);
      expect(output).not.toMatch(/does not match/);
    } finally {
      printed.mockRestore();
    }

    const server = new TestServer(config);
    await server.bootstrap();
    try {
      const migrated = server.app.get(TransactionalConnection).rawConnection;
      expect(migrated.options.synchronize).toBe(false);
      const migratedQuery: Query = sql => migrated.query(sql);
      expect(await tallyColumns(migratedQuery)).toEqual([
        'customFieldsTallycashierref', 'customFieldsTallyclientlineid', 'customFieldsTallyclientorderid',
        'customFieldsTallypayments', 'customFieldsTallypriceincludestax', 'customFieldsTallyregisterid',
        'customFieldsTallysaleat', 'customFieldsTallysessionid', 'customFieldsTallysnapshot', 'customFieldsTallyunitprice',
      ]);
      expect(await tallyIndexes(migratedQuery)).toEqual([
        'CREATE INDEX "IDX_78583fdb4ec084e117c6cf9575" ON public.tally_command USING btree ("clientOrderId")',
        'CREATE INDEX "IDX_tally_order_register_id" ON public."order" USING btree ("customFieldsTallyregisterid")',
        'CREATE INDEX "IDX_tally_order_session_id" ON public."order" USING btree ("customFieldsTallysessionid")',
        'CREATE UNIQUE INDEX "PK_cb557f149dd2aba503ab051d4fa" ON public.tally_command USING btree (id)',
        'CREATE UNIQUE INDEX "UQ_ff88d64a4e987b9203e7d767f46" ON public."order" USING btree ("customFieldsTallyclientorderid")',
      ]);
      // Ruling 2: the register and session indexes are TypeORM metadata on CustomOrderFields, so the
      // migrated schema matches the entities exactly and generateMigration would propose nothing.
      const pending = (await migrated.driver.createSchemaBuilder().log()).upQueries.map(item => item.query);
      expect(pending).toEqual([]);

      const ctx = markTallyRoute(await server.app.get(RequestContextService).create({ apiType: 'custom' }));
      const result = await server.app.get(OrderCreateService).create(ctx, orderCommand([
        { variantId: seeded.variantIds.mug[0], quantity: 1, unitPriceMinor: 800 },
      ]));
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 1000 } });
    } finally {
      await server.destroy();
    }
  });
});
