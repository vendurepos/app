import { vendureStoreSettings } from '@tallyui/connector-vendure';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The rate names the sale's per-rate rows are labelled with (VA4a) come from TallyUI's connector since 3.0.0-next.1
// (#334). These are the guarantees the app's own read (lib/tax-rate-codes.ts, removed) gave; an upgrade must keep them.
type Rate = { name: string; enabled: boolean; value: number; category: { id: string } | null; zone: { id: string }; customerGroup: { id: string } | null };
const rate = (name: string, category: string | null, zone: string, extra: Partial<Rate> = {}): Rate => ({
  name, enabled: true, value: 19, category: category === null ? null : { id: category }, zone: { id: zone }, customerGroup: null, ...extra,
});
// The dev store's seed: Standard (the default category) and Reduced, each with a German and a Danish rate.
const categories = [{ id: '1', isDefault: true }, { id: '2', isDefault: false }];
const rates = [rate('Standard DK', '1', 'DK'), rate('Standard DE', '1', 'DE'), rate('Reduced DK', '2', 'DK'), rate('Reduced DE', '2', 'DE')];
const context = { connectorId: 'vendure', baseUrl: 'http://store.test', headers: { Authorization: 'Bearer t' } };

/** Answers the connector's two queries as Vendure would, the rates filtered by the zone it asks for. */
function store(zone: string | null, taxCategories = categories, taxRates = rates) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const data = query.includes('StoreSettingsTaxRates')
      ? { taxRates: { items: taxRates.filter((item) => item.zone.id === variables.zoneId) } }
      : { activeChannel: { defaultCurrencyCode: 'EUR', pricesIncludeTax: false, defaultTaxZone: zone && { id: zone } }, taxCategories: { items: taxCategories } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("vendureStoreSettings' taxRateCodes", () => {
  it("maps each tax category to its rate's name in the default zone, and default to the default category's", async () => {
    store('DE');
    const { taxRateCodes, taxRatesPpm } = await vendureStoreSettings(context);
    expect(taxRateCodes).toEqual({ '1': 'Standard DE', '2': 'Reduced DE', default: 'Standard DE' });
    expect(Object.keys(taxRateCodes!).sort()).toEqual(Object.keys(taxRatesPpm).sort());
    store('DK');
    expect((await vendureStoreSettings(context)).taxRateCodes).toEqual({ '1': 'Standard DK', '2': 'Reduced DK', default: 'Standard DK' });
  });

  it('skips disabled, customer-group and category-less rates', async () => {
    store('DE', categories, [
      rate('Standard DE', '1', 'DE'),
      rate('Reduced off', '2', 'DE', { enabled: false }),
      rate('Reduced trade', '2', 'DE', { customerGroup: { id: '9' } }),
      rate('No category', null, 'DE'),
    ]);
    expect((await vendureStoreSettings(context)).taxRateCodes).toEqual({ '1': 'Standard DE', default: 'Standard DE' });
  });

  it('takes the first category as the default when none is flagged, and gives no default when it has no rate', async () => {
    store('DE', [{ id: '2', isDefault: false }, { id: '1', isDefault: false }]);
    expect((await vendureStoreSettings(context)).taxRateCodes?.default).toBe('Reduced DE');
    store('DE', categories, [rate('Reduced DE', '2', 'DE')]);
    expect((await vendureStoreSettings(context)).taxRateCodes).toEqual({ '2': 'Reduced DE' });
  });

  it('gives no names without a default zone', async () => {
    store(null);
    expect((await vendureStoreSettings(context)).taxRateCodes).toBeUndefined();
  });
});
