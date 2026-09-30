import { createRequire } from 'node:module';
import { OnApplicationBootstrap } from '@nestjs/common';
import {
  Channel, Customer, Logger, PluginCommonModule, ProcessContext, RequestContextService, TransactionalConnection, VendurePlugin,
} from '@vendure/core';
import type { Middleware } from '@vendure/core';
import { TallyCommandsController } from './api/commands.controller';
import { TallyInfoController } from './api/info.controller';
import { orderCustomFields, orderLineCustomFields, registerOrderIndexes } from './config/custom-fields';
import {
  TallyPriceStrategy, TallyStockLocationStrategy, tallyPaymentChecker, tallyPaymentHandler,
  tallyShippingCalculator, tallyShippingChecker,
} from './config/strategies';
import { REGISTER_ENTITIES } from './entities/register.entities';
import { TallyCommand } from './entities/tally-command.entity';
import { loggerCtx } from './service/errors';
import { OrderCreateService } from './service/order-create.service';
import { RegisterService } from './service/register.service';
import { StoreSetupService } from './service/store-setup.service';

/** A new array: `list` plus each item it does not already hold. */
function withMissing<T>(list: T[], items: T[], same: (a: T, b: T) => boolean): T[] {
  return [...list, ...items.filter(item => !list.some(existing => same(existing, item)))];
}

const COMMANDS_ROUTE = '/tally/v1/commands';
// The route's body limit in bytes (1 MiB): 50 commands of up to about 20 kB each, as medusapos allows; Vendure's
// global parser keeps 100 kB. The one source for the parser's limit and the 413 body_too_large answer (ruling 20).
export const COMMANDS_BODY_MAX_BYTES = 1_048_576;
const PROTOCOL_HEADER = 'X-Tally-Protocol';
// Ruling 16: from about this many customers, the email lookup's sequential scan is worth the README's optional index.
export const CUSTOMER_INDEX_WARN_ROWS = 50_000;
export const CUSTOMER_INDEX_SECTION = 'Optional: an index for POS customer lookups';

type Next = (error?: unknown) => void;
type Reply = { status(code: number): { json(body: unknown): void } };
type Parser = (req: unknown, res: Reply, next: Next) => void;

// The JSON parser Vendure itself uses: express is @vendure/core's dependency, so it is loaded from
// there rather than added to this package's. A body it refuses (too large, malformed) is the
// client's fault: answered here with the parser's own 4xx, never as the 500 Nest would make of it.
function commandsBodyParser(): Middleware['handler'] {
  const express = createRequire(require.resolve('@vendure/core'))('express') as { json(options: { limit: number | string }): Parser };
  const parse = express.json({ limit: COMMANDS_BODY_MAX_BYTES });
  return ((req: unknown, res: Reply, next: Next) => parse(req, res, error => {
    const status = (error as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'number' || status < 400 || status >= 500) return next(error);
    // Ruling 20: a size limit is not order-specific, so never invalid_payload.
    if (status === 413 || (error as { type?: unknown }).type === 'entity.too.large') {
      return res.status(413).json({
        code: 'body_too_large', maxBytes: COMMANDS_BODY_MAX_BYTES, message: `The request body exceeds ${COMMANDS_BODY_MAX_BYTES} bytes`,
      });
    }
    res.status(status).json({ code: 'invalid_payload', message: (error as Error).message });
  })) as Middleware['handler'];
}

/** VendurePOS: TallyUI's order.create (ADR 0002) and register commands (ADR 0003), one Postgres transaction per command. */
@VendurePlugin({
  compatibility: '^3.6.0',
  imports: [PluginCommonModule],
  entities: [TallyCommand, ...REGISTER_ENTITIES],
  controllers: [TallyInfoController, TallyCommandsController],
  providers: [OrderCreateService, RegisterService, StoreSetupService],
  exports: [OrderCreateService, RegisterService],
  // Idempotent: Vendure's starter runs runMigrations(config) and then bootstrap(config), and both
  // run this on arrays that setConfig shares with the caller's config.
  configuration: config => {
    const byName = (a: { name: string }, b: { name: string }) => a.name === b.name;
    const byCode = (a: { code: string }, b: { code: string }) => a.code === b.code;
    config.customFields.Order = withMissing(config.customFields.Order, orderCustomFields, byName);
    config.customFields.OrderLine = withMissing(config.customFields.OrderLine, orderLineCustomFields, byName);
    registerOrderIndexes();
    const { orderOptions } = config;
    if (!(orderOptions.orderItemPriceCalculationStrategy instanceof TallyPriceStrategy)) {
      orderOptions.orderItemPriceCalculationStrategy = new TallyPriceStrategy(orderOptions.orderItemPriceCalculationStrategy);
    }
    const { catalogOptions } = config;
    if (!(catalogOptions.stockLocationStrategy instanceof TallyStockLocationStrategy)) {
      catalogOptions.stockLocationStrategy = new TallyStockLocationStrategy(catalogOptions.stockLocationStrategy);
    }
    const { paymentOptions: payment, shippingOptions: shipping } = config;
    payment.paymentMethodHandlers = withMissing(payment.paymentMethodHandlers, [tallyPaymentHandler], byCode);
    payment.paymentMethodEligibilityCheckers = withMissing(payment.paymentMethodEligibilityCheckers ?? [], [tallyPaymentChecker], byCode);
    shipping.shippingEligibilityCheckers = withMissing(shipping.shippingEligibilityCheckers, [tallyShippingChecker], byCode);
    shipping.shippingCalculators = withMissing(shipping.shippingCalculators, [tallyShippingCalculator], byCode);
    const api = config.apiOptions;
    api.middleware = withMissing(api.middleware, [{ route: COMMANDS_ROUTE, handler: commandsBodyParser(), beforeListen: true }],
      (a, b) => a.route === b.route);
    // A preflight carrying X-Tally-Protocol passes without auth. Vendure's default CORS reflects the
    // requested headers; a merchant's explicit allowedHeaders list gets the header added.
    const cors = api.cors;
    if (typeof cors === 'object' && cors.allowedHeaders !== undefined) {
      const headers = typeof cors.allowedHeaders === 'string' ? cors.allowedHeaders.split(',').map(h => h.trim()) : cors.allowedHeaders;
      if (!headers.some(header => header.toLowerCase() === PROTOCOL_HEADER.toLowerCase())) {
        cors.allowedHeaders = [...headers, PROTOCOL_HEADER];
      }
    }
    return config;
  },
})
export class TallyPosPlugin implements OnApplicationBootstrap {
  constructor(
    private connection: TransactionalConnection,
    private contexts: RequestContextService,
    private processContext: ProcessContext,
    private storeSetup: StoreSetupService,
  ) {}

  // ADR 0002 "Store configuration" (review 9): in the server process only, every channel gets the
  // POS payment method, the in-store shipping method and the walk-in customer when it lacks them.
  // Each method is shared across channels; bootstrap and on-demand repairs use the same setup lock.
  async onApplicationBootstrap() {
    if (!this.processContext.isServer) return;
    // Contexts come from the channel token, so the channel carries the relations Vendure loads.
    for (const channel of await this.connection.rawConnection.getRepository(Channel).find({ order: { id: 'ASC' } })) {
      const ctx = await this.contexts.create({ apiType: 'admin', channelOrToken: channel.token });
      await this.connection.withTransaction(ctx, tx => this.storeSetup.ensureChannelSetup(tx));
    }
    // Not awaited: the check never delays the start.
    void this.warnWithoutEmailIndex().catch((error: unknown) => Logger.debug(`Customer index check skipped: ${String(error)}`, loggerCtx));
  }

  // Ruling 16: the plugin never indexes Vendure's customer table; a large one without the optional index gets one warning.
  private async warnWithoutEmailIndex() {
    const db = this.connection.rawConnection;
    const table = db.getMetadata(Customer).tablePath;
    // The planner's estimate (pg_class.reltuples, kept by ANALYZE and autovacuum) rather than a count, so a large table
    // costs nothing here; it includes soft-deleted rows, which the unindexed lookup scans too. It is -1 before the table's
    // first ANALYZE (a restore, say): the check is skipped, and a start after autovacuum has analysed the table warns.
    const [{ rows }] = await db.query('SELECT reltuples::float8 AS rows FROM pg_class WHERE oid = $1::regclass', [table]);
    if (rows < 0) {
      Logger.debug('Customer index check skipped: the customer table has not been analysed', loggerCtx);
      return;
    }
    if (rows <= CUSTOMER_INDEX_WARN_ROWS) return;
    // Only a valid index counts: a failed CREATE INDEX CONCURRENTLY leaves an INVALID one that pg_indexes still lists.
    const indexed = await db.query(`SELECT 1 FROM pg_indexes JOIN pg_index ON indexrelid = format('%I.%I', schemaname, indexname)::regclass
      WHERE format('%I.%I', schemaname, tablename)::regclass = $1::regclass AND indisvalid
      AND indexdef LIKE '%lower(("emailAddress")%'`, [table]);
    if (indexed.length) return;
    Logger.warn(`The customer table holds about ${Math.round(rows)} rows and has no lower("emailAddress") index, so each POS sale `
      + `with an email scans it. See "${CUSTOMER_INDEX_SECTION}" in the @vendurepos/plugin README.`, loggerCtx);
  }
}
