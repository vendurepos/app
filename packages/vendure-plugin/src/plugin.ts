import { OnApplicationBootstrap } from '@nestjs/common';
import {
  LanguageCode, PaymentMethodService, PluginCommonModule, RequestContextService,
  ShippingMethodService, VendurePlugin, manualFulfillmentHandler,
} from '@vendure/core';
import { TallyInfoController } from './api/info.controller';
import { orderCustomFields, orderLineCustomFields } from './config/custom-fields';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, tallyPaymentChecker, tallyPaymentHandler,
  tallyPriceStrategy, tallyShippingCalculator, tallyShippingChecker,
} from './config/strategies';
import { TallyCommand } from './entities/tally-command.entity';
import { OrderCreateService } from './service/order-create.service';

/** VendurePOS: TallyUI's order.create as one Postgres transaction per command (ADR 0002). */
@VendurePlugin({
  compatibility: '^3.6.0',
  imports: [PluginCommonModule],
  entities: [TallyCommand],
  controllers: [TallyInfoController],
  providers: [OrderCreateService],
  exports: [OrderCreateService],
  configuration: config => {
    config.customFields.Order.push(...orderCustomFields);
    config.customFields.OrderLine.push(...orderLineCustomFields);
    config.orderOptions.orderItemPriceCalculationStrategy = tallyPriceStrategy;
    config.paymentOptions.paymentMethodHandlers.push(tallyPaymentHandler);
    config.paymentOptions.paymentMethodEligibilityCheckers = [
      ...(config.paymentOptions.paymentMethodEligibilityCheckers ?? []), tallyPaymentChecker,
    ];
    config.shippingOptions.shippingEligibilityCheckers.push(tallyShippingChecker);
    config.shippingOptions.shippingCalculators.push(tallyShippingCalculator);
    return config;
  },
})
export class TallyPosPlugin implements OnApplicationBootstrap {
  constructor(
    private contexts: RequestContextService,
    private paymentMethods: PaymentMethodService,
    private shippingMethods: ShippingMethodService,
  ) {}

  // Creates the POS payment and in-store shipping methods in the default channel when missing.
  async onApplicationBootstrap() {
    const ctx = await this.contexts.create({ apiType: 'admin' });
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
