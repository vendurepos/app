import { OnApplicationBootstrap } from '@nestjs/common';
import {
  LanguageCode, PaymentMethodService, PluginCommonModule, RequestContextService,
  ShippingMethodService, VendurePlugin, manualFulfillmentHandler,
} from '@vendure/core';
import { OrderCreateService } from './order-create.service';
import { TallyCommand } from './tally-command.entity';
import { TallyCommandController } from './tally-command.controller';
import { tallyPaymentHandler, tallyPriceStrategy, tallyShippingCalculator, tallyShippingChecker } from './tally-strategies';

@VendurePlugin({
  compatibility: '^3.6.0',
  imports: [PluginCommonModule],
  entities: [TallyCommand],
  controllers: [TallyCommandController],
  providers: [OrderCreateService],
  configuration: config => {
    config.customFields.Order = [
      { name: 'tallyClientOrderId', type: 'string', unique: true, readonly: true, nullable: true },
      { name: 'tallySaleAt', type: 'datetime', readonly: true, nullable: true },
      { name: 'tallyRegisterId', type: 'string', readonly: true, nullable: true },
      { name: 'tallySessionId', type: 'string', readonly: true, nullable: true },
      { name: 'tallyCashierRef', type: 'string', readonly: true, nullable: true },
      { name: 'tallyPayments', type: 'text', readonly: true, nullable: true },
      { name: 'tallySnapshot', type: 'text', readonly: true, nullable: true },
    ];
    config.customFields.OrderLine = [
      { name: 'tallyUnitPrice', type: 'int', readonly: true, nullable: true },
      { name: 'tallyClientLineId', type: 'string', readonly: true, nullable: true },
      { name: 'tallyPriceIncludesTax', type: 'boolean', readonly: true, nullable: true },
    ];
    config.orderOptions.orderItemPriceCalculationStrategy = tallyPriceStrategy;
    config.paymentOptions.paymentMethodHandlers.push(tallyPaymentHandler);
    config.shippingOptions.shippingEligibilityCheckers.push(tallyShippingChecker);
    config.shippingOptions.shippingCalculators.push(tallyShippingCalculator);
    return config;
  },
})
export class TallySpikePlugin implements OnApplicationBootstrap {
  constructor(
    private contexts: RequestContextService,
    private paymentMethods: PaymentMethodService,
    private shippingMethods: ShippingMethodService,
  ) {}

  async onApplicationBootstrap() {
    const ctx = await this.contexts.create({ apiType: 'admin' });
    const payments = await this.paymentMethods.findAll(ctx, { filter: { code: { eq: 'tally-pos' } } });
    if (!payments.items.length) {
      await this.paymentMethods.create(ctx, {
        code: 'tally-pos', enabled: true,
        translations: [{ languageCode: LanguageCode.en, name: 'Tally POS', description: '' }],
        handler: { code: tallyPaymentHandler.code, arguments: [] },
      });
    }
    const shipping = await this.shippingMethods.findAll(ctx, { filter: { code: { eq: 'tally-in-store' } } });
    if (!shipping.items.length) {
      await this.shippingMethods.create(ctx, {
        code: 'tally-in-store', fulfillmentHandler: manualFulfillmentHandler.code,
        translations: [{ languageCode: LanguageCode.en, name: 'In-store collection', description: '' }],
        checker: { code: tallyShippingChecker.code, arguments: [] },
        calculator: { code: tallyShippingCalculator.code, arguments: [] },
      });
    }
  }
}
