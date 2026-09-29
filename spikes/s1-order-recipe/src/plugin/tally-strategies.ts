import {
  LanguageCode, PaymentMethodEligibilityChecker, PaymentMethodHandler,
  ShippingCalculator, ShippingEligibilityChecker,
} from '@vendure/core';
import type { OrderItemPriceCalculationStrategy } from '@vendure/core';
import { DefaultOrderItemPriceCalculationStrategy } from '@vendure/core/dist/config/order/default-order-item-price-calculation-strategy';

const defaultPriceStrategy = new DefaultOrderItemPriceCalculationStrategy();

export const tallyPriceStrategy: OrderItemPriceCalculationStrategy = {
  calculateUnitPrice(ctx, variant, customFields, order) {
    if (order.customFields.tallyClientOrderId && customFields.tallyUnitPrice != null) {
      return {
        price: customFields.tallyUnitPrice,
        priceIncludesTax: customFields.tallyPriceIncludesTax,
      };
    }
    return defaultPriceStrategy.calculateUnitPrice(ctx, variant);
  },
};

// ADR 0002 "Closed to the storefront": only the plugin's REST route runs with apiType 'custom'.
export const tallyPaymentHandler = new PaymentMethodHandler({
  code: 'tally-pos',
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS tender' }],
  args: {},
  createPayment: (ctx, order, amount, args, metadata) => ctx.apiType === 'custom'
    ? { amount, state: 'Settled', metadata }
    : { amount, state: 'Declined', errorMessage: 'tally-pos is only available to the POS route', metadata },
  settlePayment: () => ({ success: true }),
});

export const tallyPaymentChecker = new PaymentMethodEligibilityChecker({
  code: 'tally-pos',
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS orders' }],
  args: {},
  check: (ctx, order) => !!order.customFields.tallyClientOrderId,
});

export const tallyShippingChecker = new ShippingEligibilityChecker({
  code: 'tally-in-store',
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS orders' }],
  args: {},
  check: (ctx, order) => !!order.customFields.tallyClientOrderId,
});

export const tallyShippingCalculator = new ShippingCalculator({
  code: 'tally-in-store',
  description: [{ languageCode: LanguageCode.en, value: 'In-store collection' }],
  args: {},
  calculate: () => ({ price: 0, priceIncludesTax: false, taxRate: 0 }),
});
