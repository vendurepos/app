import { Logger, TransactionalConnection } from '@vendure/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TallyPosPlugin } from '../src';
import { CUSTOMER_INDEX_SECTION, CUSTOMER_INDEX_WARN_ROWS } from '../src/plugin';
import { createPluginTestEnvironment } from './env';

// VP3-4d (ruling 16): the plugin never indexes Vendure's customer table. A table over the threshold without the
// README's optional index gets one startup warning, and none once the index exists.
describe('VP3-4d: the startup warning for a large customer table without the email index', () => {
  const environment = createPluginTestEnvironment();
  const { server } = environment;
  let connection: TransactionalConnection;
  const query = (sql: string, parameters?: unknown[]) => connection.rawConnection.query(sql, parameters);
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

  async function bootstrapWarnings() {
    const warn = vi.spyOn(Logger, 'warn');
    await server.app.get(TallyPosPlugin).onApplicationBootstrap();
    return warn.mock.calls.map(([message]) => message);
  }

  it(`more than ${CUSTOMER_INDEX_WARN_ROWS} rows and no index: exactly one warning, naming the README section`, async () => {
    const warnings = await bootstrapWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${CUSTOMER_INDEX_SECTION}"`);
  });

  it('with the README index created: no warning', async () => {
    await query('CREATE INDEX CONCURRENTLY "IDX_customer_email_lower" ON "customer" (lower("emailAddress")) WHERE "deletedAt" IS NULL');
    expect(await bootstrapWarnings()).toEqual([]);
  });
});
