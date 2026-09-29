import {
  LanguageCode, PaymentMethodEligibilityChecker, PaymentMethodHandler,
  ShippingCalculator, ShippingEligibilityChecker, StockLocationService, idsAreEqual,
} from '@vendure/core';
import type { Injector, Order, OrderItemPriceCalculationStrategy, ProductVariant, RequestContext, StockLocationStrategy } from '@vendure/core';

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

/**
 * POS lines only (Front desk, 2026-09-29): cap Vendure 3.7.3's MultiChannel over-allocation
 * and fill its threshold under-allocation. Storefront plans and other methods stay unchanged.
 */
export class TallyStockLocationStrategy implements StockLocationStrategy {
  private injector: Injector;
  constructor(readonly inner: StockLocationStrategy) {}
  init(injector: Injector) {
    this.injector = injector;
    return this.inner.init?.(injector);
  }
  destroy() { return this.inner.destroy?.(); }
  getAvailableStock(...args: Parameters<StockLocationStrategy['getAvailableStock']>) { return this.inner.getAvailableStock(...args); }
  forRelease(...args: Parameters<StockLocationStrategy['forRelease']>) { return this.inner.forRelease(...args); }
  forSale(...args: Parameters<StockLocationStrategy['forSale']>) { return this.inner.forSale(...args); }
  forCancellation(...args: Parameters<StockLocationStrategy['forCancellation']>) { return this.inner.forCancellation(...args); }
  async forAllocation(...args: Parameters<StockLocationStrategy['forAllocation']>) {
    const [ctx, stockLocations, orderLine, quantity] = args;
    if (!orderLine.customFields?.tallyClientLineId) return this.inner.forAllocation(...args);
    // Re-read stock levels for each POS line of the same variant while retaining the transaction.
    const plan = await this.inner.forAllocation(ctx.copy(), stockLocations, orderLine, quantity);
    let sum = 0;
    const capped = plan.flatMap(entry => {
      const kept = Math.min(entry.quantity, quantity - sum);
      sum += kept;
      return kept > 0 ? [{ location: entry.location, quantity: kept }] : [];
    });
    if (sum < quantity) {
      const location = await this.injector.get(StockLocationService).defaultStockLocation(ctx);
      const entry = capped.find(item => idsAreEqual(item.location.id, location.id));
      if (entry) entry.quantity += quantity - sum;
      else capped.push({ location, quantity: quantity - sum });
    }
    return capped;
  }
}

// VP2 (the handler guard): the command route marks its context. RequestContext.copy() copies own
// symbol properties, so the mark survives Vendure's transaction copies of the context.
const TALLY_ROUTE = Symbol('vendurepos.tallyCommandRoute');

/** Marks a context as the command route's own; OrderCreateService carries the mark into its contexts. */
export function markTallyRoute(ctx: RequestContext): RequestContext {
  (ctx as unknown as Record<symbol, boolean>)[TALLY_ROUTE] = true;
  return ctx;
}

export function isTallyRoute(ctx: RequestContext): boolean {
  return (ctx as unknown as Record<symbol, boolean>)[TALLY_ROUTE] === true;
}

// ADR 0002 "Closed to the storefront": only the command route, never another plugin's REST
// controller with the same apiType 'custom'.
export const tallyPaymentHandler = new PaymentMethodHandler({
  code: TALLY_PAYMENT_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'Tally POS tender' }],
  args: {},
  createPayment: (ctx, order, amount, args, metadata) => ctx.apiType === 'custom' && isTallyRoute(ctx)
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
