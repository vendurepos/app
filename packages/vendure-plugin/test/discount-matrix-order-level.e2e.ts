// Fixture: apps/pos/lib/discount-total-matrix.test.ts. After a TallyUI bump, regenerate with
// pnpm vitest run apps/pos/lib/discount-total-matrix.test.ts -u
// The till sends no coupons (connector-vendure has no coupon path); promotions are the Vendure-side half.
import { OrderLevelTaxCalculationStrategy } from '@vendure/core';
import { discountMatrixCases } from './discount-matrix-cases';

discountMatrixCases('order-level', 'per_rate_group_items', {
  taxOptions: { orderTaxCalculationStrategy: new OrderLevelTaxCalculationStrategy() },
});
