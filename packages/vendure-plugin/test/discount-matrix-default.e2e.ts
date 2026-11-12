// Fixture: apps/pos/lib/discount-total-matrix.test.ts. After a TallyUI bump, regenerate with
// pnpm vitest run apps/pos/lib/discount-total-matrix.test.ts -u
// The till sends no coupons (connector-vendure has no coupon path); promotions are the Vendure-side half.
import { discountMatrixCases } from './discount-matrix-cases';

discountMatrixCases('default', 'per_line_items');
