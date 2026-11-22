import { describe, expect, it, vi } from 'vitest';
import type { SalesFigures } from '@tallyui/pos';
import type { SalesReportV2, SalesReportV3 } from './sales-report';
import { reportsView, storeAnswer, type Spread, type StoreSales } from './store-sales';
import { CATEGORIES_HELP_TEXT, categoriesHelp } from './reports-panel';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, ScrollView: () => null, View: () => null }));
vi.mock('@tallyui/components', () => ({}));
vi.mock('./till-sales-hero', () => ({ TillSalesHero: () => null }));
vi.mock('./use-store-sales', () => ({ useStoreSales: () => ({ status: 'loading' }) }));
vi.mock('./use-fresh-list', () => ({ useFreshList: () => [] }));

const DAY = { from: '2026-11-20', to: '2026-11-20' };
const BEFORE = { from: '2026-11-19', to: '2026-11-19' };
const V2: SalesReportV2 = {
  version: 2, timezone: 'UTC', currencyCode: 'EUR', registerId: null, cashierId: null,
  from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z',
  orders: { count: 1, salesMinor: 952, taxMinor: 0, discountsMinor: 0, itemCount: 1 },
  refunds: { count: 0, totalMinor: 0, orderCount: 0 }, byMethod: [], byDay: [], byHour: [], products: [], productsTruncated: false, taxes: [],
};
const V3: SalesReportV3 = {
  ...V2, version: 3, orders: { ...V2.orders, medianMinor: 952, largestMinor: 952 },
  categories: [{ collectionId: '2', name: 'Drinkware', quantity: 1, salesMinor: 952 }],
};
const viewOf = (store: StoreSales) => {
  const spread: Spread = { current: { medianMinor: 0, largestMinor: 0 }, comparison: undefined };
  return reportsView(store, () => ({ figures: {} as SalesFigures, hourly: null, spread }), []);
};
const answer = (report: SalesReportV2 | SalesReportV3) =>
  storeAnswer({ status: 'ok', report }, { status: 'ok', report }, DAY, BEFORE, true);

describe('categoriesHelp (8.1q)', () => {
  it('a v3 store answer shows the Categories card and its help line', () => {
    const view = viewOf(answer(V3));
    expect(view.hide).not.toContain('categories');
    expect(categoriesHelp(view)).toBe('Categories: a product in several collections counts in each.');
    expect(CATEGORIES_HELP_TEXT).toBe('Categories: a product in several collections counts in each.');
  });

  it('a v2 store answer hides the card and has no help line', () => {
    const view = viewOf(answer(V2));
    expect(view.hide).toContain('categories');
    expect(categoriesHelp(view)).toBeNull();
  });

  it('the till view has no help line', () => {
    for (const status of ['loading', 'offline', 'forbidden', 'unsupported', 'error'] as const) {
      expect(categoriesHelp(viewOf({ status }))).toBeNull();
    }
  });
});
