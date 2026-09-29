import { createRequire } from 'node:module';
import { OnApplicationBootstrap } from '@nestjs/common';
import {
  Channel, ChannelService, ConfigService, CustomerService, LanguageCode, Logger, PaymentMethodService, Permission,
  PluginCommonModule, ProcessContext, RequestContextService, ShippingMethodService, TransactionalConnection, User,
  VendurePlugin, manualFulfillmentHandler,
} from '@vendure/core';
import type { ID, Middleware, RequestContext } from '@vendure/core';
import { TallyCommandsController } from './api/commands.controller';
import { TallyInfoController } from './api/info.controller';
import { loggerCtx } from './service/errors';
import { orderCustomFields, orderLineCustomFields, registerOrderIndexes } from './config/custom-fields';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, TallyPriceStrategy, TallyStockLocationStrategy, tallyPaymentChecker, tallyPaymentHandler,
  tallyShippingCalculator, tallyShippingChecker,
} from './config/strategies';
import { TallyCommand } from './entities/tally-command.entity';
import { OrderCreateService, WALK_IN_EMAIL } from './service/order-create.service';

/** A new array: `list` plus each item it does not already hold. */
function withMissing<T>(list: T[], items: T[], same: (a: T, b: T) => boolean): T[] {
  return [...list, ...items.filter(item => !list.some(existing => same(existing, item)))];
}

const COMMANDS_ROUTE = '/tally/v1/commands';
// 50 commands of up to about 20 kB each, as medusapos allows; Vendure's global parser keeps 100 kB.
const COMMANDS_BODY_LIMIT = '1mb';
const PROTOCOL_HEADER = 'X-Tally-Protocol';

type Next = (error?: unknown) => void;
type Reply = { status(code: number): { json(body: unknown): void } };
type Parser = (req: unknown, res: Reply, next: Next) => void;

// The JSON parser Vendure itself uses: express is @vendure/core's dependency, so it is loaded from
// there rather than added to this package's. A body it refuses (too large, malformed) is the
// client's fault: answered here with the parser's own 4xx, never as the 500 Nest would make of it.
function commandsBodyParser(): Middleware['handler'] {
  const express = createRequire(require.resolve('@vendure/core'))('express') as { json(options: { limit: string }): Parser };
  const parse = express.json({ limit: COMMANDS_BODY_LIMIT });
  return ((req: unknown, res: Reply, next: Next) => parse(req, res, error => {
    const status = (error as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'number' || status < 400 || status >= 500) return next(error);
    res.status(status).json({ code: 'invalid_payload', message: (error as Error).message });
  })) as Middleware['handler'];
}

/** VendurePOS: TallyUI's order.create as one Postgres transaction per command (ADR 0002). */
@VendurePlugin({
  compatibility: '^3.6.0',
  imports: [PluginCommonModule],
  entities: [TallyCommand],
  controllers: [TallyInfoController, TallyCommandsController],
  providers: [OrderCreateService],
  exports: [OrderCreateService],
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
    private config: ConfigService,
    private channels: ChannelService,
    private connection: TransactionalConnection,
    private contexts: RequestContextService,
    private customers: CustomerService,
    private paymentMethods: PaymentMethodService,
    private processContext: ProcessContext,
    private shippingMethods: ShippingMethodService,
  ) {}

  // ADR 0002 "Store configuration" (review 9): in the server process only, every channel gets the
  // POS payment method, the in-store shipping method and the walk-in customer when it lacks them.
  // N4 ruling: each method is created once, in the default channel, and assigned to the others, so
  // the default channel holds one of each rather than a copy per channel.
  async onApplicationBootstrap() {
    if (!this.processContext.isServer) return;
    // The assign mutations check the active user's permissions on the target channel.
    const identifier = this.config.authOptions.superadminCredentials?.identifier;
    const found = identifier ? await this.connection.rawConnection.getRepository(User).findOne({
      where: { identifier }, relations: ['roles', 'roles.channels'],
    }) : null;
    // Review nit 3: without a usable superadmin, skip the assignment rather than stop the server.
    const user = found?.roles.some(role => role.permissions.includes(Permission.SuperAdmin)) ? found : undefined;
    if (!user) {
      Logger.error(`The superadmin "${identifier}" (authOptions.superadminCredentials.identifier) ${found ? 'lacks the SuperAdmin '
        + 'permission' : 'was not found'}, so the POS payment and shipping methods are not assigned to the other channels`, loggerCtx);
    }
    // Contexts come from the channel token, so the channel carries the relations Vendure loads.
    const context = (token: string) => this.contexts.create({ apiType: 'admin', channelOrToken: token, user });
    const defaultCtx = await context((await this.channels.getDefaultChannel()).token);
    const paymentMethodId = await this.ensurePayment(defaultCtx);
    const shippingMethodId = await this.ensureShipping(defaultCtx);
    for (const channel of await this.connection.rawConnection.getRepository(Channel).find({ order: { id: 'ASC' } })) {
      const ctx = await context(channel.token);
      const byCode = (code: string) => ({ filter: { code: { eq: code } } });
      if (user && !(await this.paymentMethods.findAll(ctx, byCode(TALLY_PAYMENT_METHOD_CODE))).items.length) {
        await this.paymentMethods.assignPaymentMethodsToChannel(defaultCtx, { paymentMethodIds: [paymentMethodId], channelId: channel.id });
      }
      if (user && !(await this.shippingMethods.findAll(ctx, byCode(TALLY_SHIPPING_METHOD_CODE))).items.length) {
        await this.shippingMethods.assignShippingMethodsToChannel(defaultCtx, { shippingMethodIds: [shippingMethodId], channelId: channel.id });
      }
      const walkIn = await this.customers.findAll(ctx, { filter: { emailAddress: { eq: WALK_IN_EMAIL } } });
      if (!walkIn.items.length) {
        await this.customers.createOrUpdate(ctx, { emailAddress: WALK_IN_EMAIL, firstName: '', lastName: '' });
      }
    }
  }

  private async ensurePayment(ctx: RequestContext): Promise<ID> {
    const payments = await this.paymentMethods.findAll(ctx, { filter: { code: { eq: TALLY_PAYMENT_METHOD_CODE } } });
    const checker = { code: tallyPaymentChecker.code, arguments: [] };
    if (!payments.items.length) {
      return (await this.paymentMethods.create(ctx, {
        code: TALLY_PAYMENT_METHOD_CODE, enabled: true, checker,
        translations: [{ languageCode: LanguageCode.en, name: 'Tally POS', description: '' }],
        handler: { code: tallyPaymentHandler.code, arguments: [] },
      })).id;
    }
    if (!payments.items[0].checker) await this.paymentMethods.update(ctx, { id: payments.items[0].id, checker });
    return payments.items[0].id;
  }

  private async ensureShipping(ctx: RequestContext): Promise<ID> {
    const shipping = await this.shippingMethods.findAll(ctx, { filter: { code: { eq: TALLY_SHIPPING_METHOD_CODE } } });
    if (shipping.items.length) return shipping.items[0].id;
    return (await this.shippingMethods.create(ctx, {
      code: TALLY_SHIPPING_METHOD_CODE, fulfillmentHandler: manualFulfillmentHandler.code,
      translations: [{ languageCode: LanguageCode.en, name: 'In-store collection', description: '' }],
      checker: { code: tallyShippingChecker.code, arguments: [] },
      calculator: { code: tallyShippingCalculator.code, arguments: [] },
    })).id;
  }
}
