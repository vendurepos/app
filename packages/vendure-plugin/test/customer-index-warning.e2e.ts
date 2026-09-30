import { Logger, TransactionalConnection } from '@vendure/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyPosPlugin } from '../src';
import { CUSTOMER_INDEX_SECTION, CUSTOMER_INDEX_WARN_ROWS } from '../src/plugin';
import { createPluginTestEnvironment } from './env';

type IndexCheck = { warnWithoutEmailIndex: () => Promise<void> };

// VP3-4d (ruling 16): the plugin never indexes Vendure's customer table. A table over the threshold without the
// README's optional index gets one startup warning, and none once the index exists. VP3-4e: the check never delays
// the start, is skipped for a table never analysed, and ignores an invalid index.
describe('VP3-4d: the startup warning for a large customer table without the email index', () => {
  const environment = createPluginTestEnvironment();
  const { server } = environment;
  let connection: TransactionalConnection;
  const query = (sql: string, parameters?: unknown[]) => connection.rawConnection.query(sql, parameters);
  const plugin = () => server.app.get(TallyPosPlugin);
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    await query(`INSERT INTO customer ("firstName", "lastName", "emailAddress")
      SELECT 'Index', 'Warning', 'vp3-4d-warn-' || g || '@example.com' FROM generate_series(1, $1::int) AS g`,
    [CUSTOMER_INDEX_WARN_ROWS + 1]);
    // The warning reads the planner's estimate; ANALYZE brings it up to date (it reads every page of a table this size).
    await query('ANALYZE customer');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await query('DROP INDEX IF EXISTS "IDX_customer_email_lower"');
    await query(`DELETE FROM customer WHERE "emailAddress" LIKE 'vp3-4d-warn-%'`);
    await query('ANALYZE customer');
    await server.destroy();
  });

  // onApplicationBootstrap does not await the check, so the tests call it directly.
  async function checkWarnings() {
    const warn = vi.spyOn(Logger, 'warn');
    await (plugin() as unknown as IndexCheck).warnWithoutEmailIndex();
    return warn.mock.calls.map(([message]) => message);
  }

  it(`more than ${CUSTOMER_INDEX_WARN_ROWS} rows and no index: exactly one warning, naming the README section`, async () => {
    const warnings = await checkWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${CUSTOMER_INDEX_SECTION}"`);
  });

  it('a table never analysed (reltuples -1): no warning and no count(*)', async () => {
    await query(`UPDATE pg_class SET reltuples = -1 WHERE oid = 'customer'::regclass`);
    try {
      const sql = vi.spyOn(connection.rawConnection, 'query');
      expect(await checkWarnings()).toEqual([]);
      expect(sql.mock.calls.map(([text]) => text).filter(text => /count\(/i.test(text))).toEqual([]);
    } finally {
      await query('ANALYZE customer');
    }
  });

  it('an invalid index (a failed CREATE INDEX CONCURRENTLY) does not count: one warning', async () => {
    await query('CREATE INDEX CONCURRENTLY "IDX_customer_email_lower" ON "customer" (lower("emailAddress")) WHERE "deletedAt" IS NULL');
    try {
      await query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"IDX_customer_email_lower"'::regclass`);
      expect(await checkWarnings()).toHaveLength(1);
    } finally {
      await query('DROP INDEX IF EXISTS "IDX_customer_email_lower"');
    }
  });

  it('with the README index created: no warning', async () => {
    await query('CREATE INDEX CONCURRENTLY "IDX_customer_email_lower" ON "customer" (lower("emailAddress")) WHERE "deletedAt" IS NULL');
    expect(await checkWarnings()).toEqual([]);
  });

  it('onApplicationBootstrap does not wait for the check', async () => {
    const check = vi.spyOn(plugin() as unknown as IndexCheck, 'warnWithoutEmailIndex').mockReturnValue(new Promise(() => {}));
    await plugin().onApplicationBootstrap();
    expect(check).toHaveBeenCalledTimes(1);
  }, 5_000);
});
