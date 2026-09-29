import {
  LanguageCode, PaymentMethodEligibilityChecker, PaymentMethodHandler,
  ShippingCalculator, ShippingEligibilityChecker,
} from '@vendure/core';
import type { OrderItemPriceCalculationStrategy } from '@vendure/core';
// Not exported from @vendure/core's index in 3.7.3 (S1 finding 3).
import { DefaultOrderItemPriceCalculationStrategy } from '@vendure/core/dist/config/order/default-order-item-price-calculation-strategy';

export const TALLY_PAYMENT_METHOD_CODE = 'tally-pos';
export const TALLY_SHIPPING_METHOD_CODE = 'tally-in-store';

const defaultPriceStrategy = new DefaultOrderItemPriceCalculationStrategy();

// ADR 0002 "As-sold price and tax mode": POS orders keep the till's unit price in the line's own mode.
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

// ADR 0002 "Closed to the storefront": only a plugin REST route runs with apiType 'custom'.
export const tallyPaymentHandler = new PaymentMethodHandler({
  code: TALLY_PAYMENT_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS tender' }],
  args: {},
  createPayment: (ctx, order, amount, args, metadata) => ctx.apiType === 'custom'
    ? { amount, state: 'Settled', metadata }
    : { amount, state: 'Declined', errorMessage: 'tally-pos is only available to the POS route', metadata },
  settlePayment: () => ({ success: true }),
});

export const tallyPaymentChecker = new PaymentMethodEligibilityChecker({
  code: TALLY_PAYMENT_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS orders' }],
  args: {},
  check: (ctx, order) => !!order.customFields.tallyClientOrderId,
});

export const tallyShippingChecker = new ShippingEligibilityChecker({
  code: TALLY_SHIPPING_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS orders' }],
  args: {},
  check: (ctx, order) => !!order.customFields.tallyClientOrderId,
});

export const tallyShippingCalculator = new ShippingCalculator({
  code: TALLY_SHIPPING_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'In-store collection' }],
  args: {},
  calculate: () => ({ price: 0, priceIncludesTax: false, taxRate: 0 }),
});
