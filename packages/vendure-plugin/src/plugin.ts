import { OnApplicationBootstrap } from '@nestjs/common';
import {
  Channel, CustomerService, LanguageCode, PaymentMethodService, PluginCommonModule, ProcessContext,
  RequestContextService, ShippingMethodService, TransactionalConnection, VendurePlugin, manualFulfillmentHandler,
} from '@vendure/core';
import type { RequestContext } from '@vendure/core';
import { TallyInfoController } from './api/info.controller';
import { orderCustomFields, orderLineCustomFields, registerOrderIndexes } from './config/custom-fields';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, TallyPriceStrategy, tallyPaymentChecker, tallyPaymentHandler,
  tallyShippingCalculator, tallyShippingChecker,
} from './config/strategies';
import { TallyCommand } from './entities/tally-command.entity';
import { OrderCreateService, WALK_IN_EMAIL } from './service/order-create.service';

/** A new array: `list` plus each item it does not already hold. */
function withMissing<T>(list: T[], items: T[], same: (a: T, b: T) => boolean): T[] {
  return [...list, ...items.filter(item => !list.some(existing => same(existing, item)))];
}

/** VendurePOS: TallyUI's order.create as one Postgres transaction per command (ADR 0002). */
@VendurePlugin({
  compatibility: '^3.6.0',
  imports: [PluginCommonModule],
  entities: [TallyCommand],
  controllers: [TallyInfoController],
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
    const { paymentOptions: payment, shippingOptions: shipping } = config;
    payment.paymentMethodHandlers = withMissing(payment.paymentMethodHandlers, [tallyPaymentHandler], byCode);
    payment.paymentMethodEligibilityCheckers = withMissing(payment.paymentMethodEligibilityCheckers ?? [], [tallyPaymentChecker], byCode);
    shipping.shippingEligibilityCheckers = withMissing(shipping.shippingEligibilityCheckers, [tallyShippingChecker], byCode);
    shipping.shippingCalculators = withMissing(shipping.shippingCalculators, [tallyShippingCalculator], byCode);
    return config;
  },
})
export class TallyPosPlugin implements OnApplicationBootstrap {
  constructor(
    private connection: TransactionalConnection,
    private contexts: RequestContextService,
    private customers: CustomerService,
    private paymentMethods: PaymentMethodService,
    private processContext: ProcessContext,
    private shippingMethods: ShippingMethodService,
  ) {}

  // ADR 0002 "Store configuration" (review 9): in the server process only, every channel gets the
  // POS payment method, the in-store shipping method and the walk-in customer when it lacks them.
  // Default channel first: Vendure also assigns what it creates in any channel to the default one.
  async onApplicationBootstrap() {
    if (!this.processContext.isServer) return;
    for (const channel of await this.connection.rawConnection.getRepository(Channel).find({ order: { id: 'ASC' } })) {
      const ctx = await this.contexts.create({ apiType: 'admin', channelOrToken: channel });
      await this.ensurePayment(ctx);
      await this.ensureShipping(ctx);
      const walkIn = await this.customers.findAll(ctx, { filter: { emailAddress: { eq: WALK_IN_EMAIL } } });
      if (!walkIn.items.length) {
        await this.customers.createOrUpdate(ctx, { emailAddress: WALK_IN_EMAIL, firstName: '', lastName: '' });
      }
    }
  }

  private async ensurePayment(ctx: RequestContext) {
    const payments = await this.paymentMethods.findAll(ctx, { filter: { code: { eq: TALLY_PAYMENT_METHOD_CODE } } });
    const checker = { code: tallyPaymentChecker.code, arguments: [] };
    if (!payments.items.length) {
      await this.paymentMethods.create(ctx, {
        code: TALLY_PAYMENT_METHOD_CODE, enabled: true, checker,
        translations: [{ languageCode: LanguageCode.en, name: 'Tally POS', description: '' }],
        handler: { code: tallyPaymentHandler.code, arguments: [] },
      });
    } else if (!payments.items[0].checker) {
      await this.paymentMethods.update(ctx, { id: payments.items[0].id, checker });
    }
  }

  private async ensureShipping(ctx: RequestContext) {
    const shipping = await this.shippingMethods.findAll(ctx, { filter: { code: { eq: TALLY_SHIPPING_METHOD_CODE } } });
    if (!shipping.items.length) {
      await this.shippingMethods.create(ctx, {
        code: TALLY_SHIPPING_METHOD_CODE, fulfillmentHandler: manualFulfillmentHandler.code,
        translations: [{ languageCode: LanguageCode.en, name: 'In-store collection', description: '' }],
        checker: { code: tallyShippingChecker.code, arguments: [] },
        calculator: { code: tallyShippingCalculator.code, arguments: [] },
      });
    }
  }
}
