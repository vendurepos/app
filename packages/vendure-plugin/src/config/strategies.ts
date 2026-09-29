import {
  LanguageCode, PaymentMethodEligibilityChecker, PaymentMethodHandler,
  ShippingCalculator, ShippingEligibilityChecker,
} from '@vendure/core';
import type { Injector, Order, OrderItemPriceCalculationStrategy, ProductVariant, RequestContext } from '@vendure/core';

export const TALLY_PAYMENT_METHOD_CODE = 'tally-pos';
export const TALLY_SHIPPING_METHOD_CODE = 'tally-in-store';

/**
 * ADR 0002 "As-sold price and tax mode": POS orders keep the till's unit price in the line's own
 * mode. Every other line, and the strategy's lifecycle, goes to the merchant's configured strategy
 * (review 7).
 */
export class TallyPriceStrategy implements OrderItemPriceCalculationStrategy {
  constructor(readonly inner: OrderItemPriceCalculationStrategy) {}

  init(injector: Injector) {
    return this.inner.init?.(injector);
  }

  destroy() {
    return this.inner.destroy?.();
  }

  calculateUnitPrice(ctx: RequestContext, variant: ProductVariant, customFields: Record<string, any>, order: Order, quantity: number) {
    if (order.customFields.tallyClientOrderId && customFields.tallyUnitPrice != null) {
      return {
        price: customFields.tallyUnitPrice,
        priceIncludesTax: customFields.tallyPriceIncludesTax,
      };
    }
    return this.inner.calculateUnitPrice(ctx, variant, customFields, order, quantity);
  }
}

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
