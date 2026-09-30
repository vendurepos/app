import { vendureStoreSettings } from '@tallyui/connector-vendure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTaxRateCodes, taxRateCodes, type TaxRateItem } from './tax-rate-codes';

const rate = (name: string, category: string | null, zone: string, extra: Partial<TaxRateItem> = {}): TaxRateItem => ({
  name, enabled: true, category: category === null ? null : { id: category }, zone: { id: zone }, customerGroup: null, ...extra,
});
// The dev store's seed: Standard (the default category) and Reduced, each with a German and a Danish rate.
const categories = [{ id: '1', isDefault: true }, { id: '2', isDefault: false }];
const rates = [rate('Standard DK', '1', 'DK'), rate('Standard DE', '1', 'DE'), rate('Reduced DK', '2', 'DK'), rate('Reduced DE', '2', 'DE')];

afterEach(() => vi.unstubAllGlobals());

describe('taxRateCodes', () => {
  it("maps each tax category to its rate's name in the default zone, and default to the default category's", () => {
    expect(taxRateCodes('DE', categories, rates)).toEqual({ '1': 'Standard DE', '2': 'Reduced DE', default: 'Standard DE' });
    expect(taxRateCodes('DK', categories, rates)).toEqual({ '1': 'Standard DK', '2': 'Reduced DK', default: 'Standard DK' });
  });

  it('skips disabled, customer-group and category-less rates, as the connector does for taxRatesPpm', () => {
    expect(taxRateCodes('DE', categories, [
      rate('Standard DE', '1', 'DE'),
      rate('Reduced off', '2', 'DE', { enabled: false }),
      rate('Reduced trade', '2', 'DE', { customerGroup: { id: '9' } }),
      rate('No category', null, 'DE'),
    ])).toEqual({ '1': 'Standard DE', default: 'Standard DE' });
  });

  it('takes the first category as the default when none is flagged, and gives no default when it has no rate', () => {
    const unflagged = [{ id: '2', isDefault: false }, { id: '1', isDefault: false }];
    expect(taxRateCodes('DE', unflagged, rates).default).toBe('Reduced DE');
    expect(taxRateCodes('DE', categories, [rate('Reduced DE', '2', 'DE')])).toEqual({ '2': 'Reduced DE' });
  });

  it('gives no names without a default zone', () => {
    expect(taxRateCodes(undefined, categories, rates)).toEqual({});
  });

  it("keys the names as the connector keys taxRatesPpm, so every named class has a rate", async () => {
    const values: Record<string, number> = { 'Standard DE': 19, 'Reduced DE': 7, 'Standard DK': 25, 'Reduced DK': 25 };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      const data = query.includes('TaxRateCodes')
        ? { activeChannel: { defaultTaxZone: { id: 'DE' } }, taxCategories: { items: categories }, taxRates: { items: rates } }
        : query.includes('StoreSettingsTaxRates')
          ? { taxRates: { items: rates.filter((item) => item.zone!.id === variables.zoneId).map((item) => ({ ...item, value: values[item.name] })) } }
          : { activeChannel: { defaultCurrencyCode: 'EUR', pricesIncludeTax: false, defaultTaxZone: { id: 'DE' } }, taxCategories: { items: categories } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }));
    const context = { connectorId: 'vendure', baseUrl: 'http://store.test', headers: { Authorization: 'Bearer t' } };
    const codes = await fetchTaxRateCodes(context);
    const { taxRatesPpm } = await vendureStoreSettings(context);
    expect(codes).toEqual({ '1': 'Standard DE', '2': 'Reduced DE', default: 'Standard DE' });
    expect(Object.keys(codes).sort()).toEqual(Object.keys(taxRatesPpm).sort());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://store.test/admin-api');
    expect(vi.mocked(fetch).mock.calls[0][1]!.headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  it('throws on a GraphQL error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'Forbidden' }] }), { status: 200 })));
    await expect(fetchTaxRateCodes({ connectorId: 'vendure', baseUrl: 'http://store.test', headers: {} })).rejects.toThrow('Forbidden');
  });
});
