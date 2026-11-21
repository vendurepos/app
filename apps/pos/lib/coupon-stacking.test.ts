import {
  couponPricingBasis, createOrderBuilder, createTaxContext, taxProviderProps,
  type Order, type StorePricedCoupon,
} from '@tallyui/pos';
import { describe, expect, it } from 'vitest';

const COUPON_MINOR = 600;
const fixtures = [
  { name: 'F1', unit: 2000, quantity: 3 },
  { name: 'F2', unit: 1999, quantity: 3 },
];

describe('CPN-S Q1: percent till discount and store-priced coupon stacking', () => {
  for (const { name, unit, quantity } of fixtures) {
    it(`${name}: both application orders retain the pre-coupon till discount`, () => {
      const orders = (['X', 'Y'] as const).map((sequence) => {
        const builder = createOrderBuilder({
          currency: 'EUR',
          taxContext: createTaxContext(taxProviderProps({
            currency: 'EUR', pricesIncludeTax: false,
            taxRatesPpm: { default: 250_000, '1': 250_000 },
            taxRateCodes: { default: 'Standard', '1': 'Standard' },
            taxRounding: { granularity: 'per_line_items', mode: 'half_up' },
          })),
        });
        const lineId = builder.addLine({
          productId: 'mug', variantId: 'mug-800', name: 'Mug', sku: 'mug-800',
          unitPrice: { amount: unit, currency: 'EUR', taxInclusive: false },
          quantity, taxClass: '1',
        });
        const priced = new Map<string, StorePricedCoupon>([
          ['spike10', { couponId: 'P_CODE', lines: [{ lineId, amountMinor: COUPON_MINOR }] }],
        ]);
        if (sequence === 'Y') {
          builder.setCoupons(['spike10'], {
            kind: 'store-priced', priced, basis: couponPricingBasis(builder.getSnapshot()),
          });
        }
        builder.applyLineDiscount(lineId, { type: 'percentage', value: 10 });
        builder.setCoupons(['spike10'], {
          kind: 'store-priced', priced, basis: couponPricingBasis(builder.getSnapshot()),
        });
        return builder.getSnapshot();
      });
      const [x, y] = orders;
      const figures = (order: Order) => ({
        totalMinor: order.totalMinor,
        taxMinor: order.taxMinor,
        couponDiscountMinor: order.coupons![0].discountMinor,
        couponTaxMinor: order.coupons![0].discountTaxMinor,
      });
      // First-run observations supply the literals for B4 only if Q1 passes.
      process.stdout.write(`${name} ${JSON.stringify(orders.map(order => ({
        ...figures(order), tillDiscountMinor: order.lineItems[0].discounts[0].amountMinor,
      })))}\n`);
      expect(x.lineItems[0].discounts[0].amountMinor).toBe(Math.round(0.10 * unit * quantity));
      expect(y.lineItems[0].discounts[0].amountMinor).toBe(Math.round(0.10 * unit * quantity));
      expect(figures(x)).toEqual(figures(y));
    });
  }
});
