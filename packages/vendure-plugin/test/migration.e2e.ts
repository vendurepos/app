import { RequestContextService, TransactionalConnection, runMigrations } from '@vendure/core';
import { TestServer } from '@vendure/testing';
import { describe, expect, it, vi } from 'vitest';
import { OrderCreateService, RegisterService, TallyPos1790648006022, TallyPosRegister1790800000000, TallyPosRegisterV21791000000000, TallyPosRegisterOpenVersion1791100000000, TallyPosV51790900000000, TallyPosVp2a1790720000000 } from '../src';
import { markTallyRoute } from '../src/config/strategies';
import { createPluginTestEnvironment, dbConnectionOptions, pluginTestConfig } from './env';
import { orderCommand } from './payloads';

type Query = (sql: string) => Promise<Array<Record<string, string>>>;
const tallyColumns = async (query: Query) => (await query(
  `SELECT column_name FROM information_schema.columns WHERE table_name IN ('order', 'order_line')
   AND column_name LIKE 'customFieldsTally%' ORDER BY column_name`)).map(row => row.column_name);
const tallyIndexes = async (query: Query) => (await query(
  `SELECT indexdef FROM pg_indexes WHERE (tablename = 'order' AND indexdef LIKE '%Tally%')
   OR tablename LIKE 'tally_%' ORDER BY indexname`)).map(row => row.indexdef);

describe('the TallyPos migration', () => {
  it('runs with synchronize: false on a Vendure database without the plugin\'s schema; the server then starts and sells', async () => {
    // Vendure's AppModule fixes the plugin set once per process, so the plugin-free schema is made by
    // synchronizing with the plugin (and seeding the catalogue), then removing every plugin artefact.
    const seeded = createPluginTestEnvironment();
    await seeded.init();
    const raw = seeded.server.app.get(TransactionalConnection).rawConnection;
    const runner = raw.createQueryRunner();
    try {
      await new TallyPosRegisterOpenVersion1791100000000().down(runner);
      expect((await raw.driver.createSchemaBuilder().log()).upQueries.map(item => item.query)).toEqual([
        'ALTER TABLE "tally_register_session" ADD "openVersion" integer',
      ]);
      await new TallyPosRegisterOpenVersion1791100000000().up(runner);
      await new TallyPosRegisterV21791000000000().down(runner);
      expect((await raw.driver.createSchemaBuilder().log()).upQueries.map(item => item.query)).toEqual([
        'CREATE TABLE "tally_register_session_alias" ("channelId" character varying NOT NULL, "id" character varying NOT NULL, "sessionId" character varying NOT NULL, "commandId" character varying NOT NULL, "receivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b759fdc911b503ab399194b2cde" PRIMARY KEY ("channelId", "id"))',
        'CREATE INDEX "IDX_bd172624d55396a2353622b924" ON "tally_register_session_alias" ("channelId", "sessionId") ',
        'ALTER TABLE "tally_register_session" ADD "deviceId" character varying',
        'ALTER TABLE "tally_register_session" ADD "deviceName" character varying',
        'ALTER TABLE "tally_register_session" ADD "supersedes" character varying',
        'ALTER TABLE "tally_register_session" ADD CONSTRAINT "UQ_d767ba1e95deebc176f4a7b9b4c" UNIQUE ("channelId", "supersedes")',
      ]);
      await new TallyPosRegisterV21791000000000().up(runner);
      await new TallyPosV51790900000000().down(runner);
      expect((await raw.driver.createSchemaBuilder().log()).upQueries.map(item => item.query).sort()).toEqual([
        'ALTER TABLE "order" ADD "customFieldsTallyshipping" text',
        'ALTER TABLE "order_line" ADD "customFieldsTallycustomname" character varying(255)',
        'ALTER TABLE "order_line" ADD "customFieldsTallycustomsku" character varying(64)',
      ]);
      await new TallyPosV51790900000000().up(runner);
    } finally { await runner.release(); }
    const [{ database }] = await raw.query('SELECT current_database() AS database');
    for (const table of ['tally_register_session_alias', 'tally_command', 'tally_register_closure', 'tally_register_movement', 'tally_register_session_status',
      'tally_register_session', 'tally_register']) await raw.query(`DROP TABLE "${table}"`);
    for (const [table, columns] of [
      ['order', ['Tallyclientorderid', 'Tallysaleat', 'Tallyregisterid', 'Tallysessionid', 'Tallycashierref', 'Tallypayments', 'Tallysnapshot',
        'Tallyrejectedclientorderid', 'Tallyrejected', 'Tallyshipping']],
      ['order_line', ['Tallyunitprice', 'Tallyclientlineid', 'Tallypriceincludestax', 'Tallycustomname', 'Tallycustomsku']],
    ] as const) {
      for (const column of columns) await raw.query(`ALTER TABLE "${table}" DROP COLUMN "customFields${column}"`);
    }
    const query: Query = sql => raw.query(sql);
    expect(await tallyColumns(query)).toEqual([]);
    expect(await tallyIndexes(query)).toEqual([]);
    expect(await raw.query("SELECT to_regclass('tally_command') AS ledger")).toEqual([{ ledger: null }]);
    await seeded.server.destroy();

    const config = pluginTestConfig({ dbConnectionOptions: {
      ...dbConnectionOptions, database, synchronize: false,
      migrations: [TallyPos1790648006022, TallyPosVp2a1790720000000, TallyPosRegister1790800000000, TallyPosV51790900000000, TallyPosRegisterV21791000000000, TallyPosRegisterOpenVersion1791100000000],
    } });
    // runMigrations prints "Your database schema does not match…" when the schema diff is not empty.
    const printed = vi.spyOn(console, 'log');
    try {
      expect(await runMigrations(config)).toEqual(['TallyPos1790648006022', 'TallyPosVp2a1790720000000', 'TallyPosRegister1790800000000', 'TallyPosV51790900000000', 'TallyPosRegisterV21791000000000', 'TallyPosRegisterOpenVersion1791100000000']);
      const output = printed.mock.calls.flat().join('\n');
      expect(output).toMatch(/Successfully ran migration: TallyPos1790648006022[\s\S]*Successfully ran migration: TallyPosVp2a1790720000000[\s\S]*Successfully ran migration: TallyPosRegister1790800000000[\s\S]*Successfully ran migration: TallyPosV51790900000000[\s\S]*Successfully ran migration: TallyPosRegisterV21791000000000[\s\S]*Successfully ran migration: TallyPosRegisterOpenVersion1791100000000/);
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
        'customFieldsTallycustomname', 'customFieldsTallycustomsku', 'customFieldsTallypayments',
        'customFieldsTallypriceincludestax', 'customFieldsTallyregisterid', 'customFieldsTallyrejected', 'customFieldsTallyrejectedclientorderid',
        'customFieldsTallysaleat', 'customFieldsTallysessionid', 'customFieldsTallyshipping', 'customFieldsTallysnapshot', 'customFieldsTallyunitprice',
      ]);
      expect(await tallyIndexes(migratedQuery)).toEqual([
        'CREATE INDEX "IDX_57884f6d20b5ab78302240976b" ON public.tally_register_session USING btree ("channelId", "registerId")',
        'CREATE INDEX "IDX_78583fdb4ec084e117c6cf9575" ON public.tally_command USING btree ("clientOrderId")',
        'CREATE INDEX "IDX_b67faa4ff7b28e4af0694dd306" ON public.tally_register_movement USING btree ("channelId", "sessionId")',
        'CREATE INDEX "IDX_bd172624d55396a2353622b924" ON public.tally_register_session_alias USING btree ("channelId", "sessionId")',
        'CREATE INDEX "IDX_e1da3bd8299c5d80a4313dc675" ON public.tally_register_session_status USING btree ("channelId", "sessionId")',
        'CREATE INDEX "IDX_tally_order_register_id" ON public."order" USING btree ("customFieldsTallyregisterid")',
        'CREATE INDEX "IDX_tally_order_session_id" ON public."order" USING btree ("customFieldsTallysessionid")',
        'CREATE UNIQUE INDEX "PK_330cffe5f4469e0c7f55994b786" ON public.tally_register USING btree ("channelId", id)',
        'CREATE UNIQUE INDEX "PK_441df0923693354d46e6dc30d5e" ON public.tally_register_movement USING btree ("channelId", id)',
        'CREATE UNIQUE INDEX "PK_694799ddf1a169afc649e41ec4b" ON public.tally_register_session USING btree ("channelId", id)',
        'CREATE UNIQUE INDEX "PK_8d97c69187624fabbee2bff5955" ON public.tally_register_closure USING btree ("channelId", id)',
        'CREATE UNIQUE INDEX "PK_b759fdc911b503ab399194b2cde" ON public.tally_register_session_alias USING btree ("channelId", id)',
        'CREATE UNIQUE INDEX "PK_cb557f149dd2aba503ab051d4fa" ON public.tally_command USING btree (id)',
        'CREATE UNIQUE INDEX "PK_e3bf54fd35c91c8b9813c6ba23f" ON public.tally_register_session_status USING btree (seq)',
        'CREATE UNIQUE INDEX "UQ_50e2490a4c8604fe712a3934543" ON public.tally_register_movement USING btree ("channelId", voids)',
        'CREATE UNIQUE INDEX "UQ_82e1f0bdede8def7051d66f0740" ON public.tally_register_closure USING btree ("channelId", "sessionId")',
        'CREATE UNIQUE INDEX "UQ_d767ba1e95deebc176f4a7b9b4c" ON public.tally_register_session USING btree ("channelId", supersedes)',
        'CREATE UNIQUE INDEX "UQ_fdc8938aa0359ee820b04de0376" ON public.tally_register_closure USING btree ("channelId", "registerId", number)',
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
      // ADR 0003: a register command's ledger row, without a clientOrderId, and its tables.
      const opened = await server.app.get(RegisterService).apply(ctx, { id: 'migration-open', type: 'register.session.open', version: 1,
        createdAt: '2026-09-28T10:00:00Z', deviceId: 'd', attempt: 1,
        payload: { sessionId: 's-1', registerId: 'r-1', openedAt: '2026-09-28T10:00:00Z', countedFloatMinor: 0 } });
      expect(opened).toMatchObject({ status: 'applied', register: { session: { id: 's-1', status: 'open' } } });
    } finally {
      await server.destroy();
    }
  });
});
