import type { SyncContext } from '@tallyui/core';

// Vendure's default adminListQueryLimit; a channel has far fewer tax rates.
const TAX_RATES_QUERY = `query TaxRateCodes {
  activeChannel { defaultTaxZone { id } }
  taxCategories { items { id isDefault } }
  taxRates(options: { take: 1000 }) { items { name enabled category { id } zone { id } customerGroup { id } } }
}`;

type TaxCategory = { id: string; isDefault: boolean };
export type TaxRateItem = {
  name: string; enabled: boolean;
  category: { id: string } | null; zone: { id: string } | null; customerGroup: { id: string } | null;
};

/**
 * Tax class → Vendure TaxRate name, for `<TaxProvider rateCodes>`: `per_rate_group_items` groups by rate name and value
 * (vendurepos #60, TallyUI #312). Keyed and filtered exactly as @tallyui/connector-vendure's store-settings.ts keys
 * `taxRatesPpm`: the default zone's enabled rates with no customer group, by tax category id (the last rate wins), and
 * `default` for the default category (isDefault, else the first).
 */
export function taxRateCodes(zoneId: string | undefined, categories: TaxCategory[], rates: TaxRateItem[]): Record<string, string> {
  const codes: Record<string, string> = {};
  if (zoneId === undefined) return codes;
  for (const rate of rates) {
    if (!rate.enabled || rate.customerGroup || !rate.category || rate.zone?.id !== zoneId) continue;
    codes[rate.category.id] = rate.name;
  }
  const defaultCategory = categories.find((category) => category.isDefault) ?? categories[0];
  if (defaultCategory && Object.hasOwn(codes, defaultCategory.id)) codes.default = codes[defaultCategory.id];
  return codes;
}

export async function fetchTaxRateCodes(context: SyncContext): Promise<Record<string, string>> {
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal, body: JSON.stringify({ query: TAX_RATES_QUERY }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return taxRateCodes(body.data.activeChannel?.defaultTaxZone?.id, body.data.taxCategories.items, body.data.taxRates.items);
}
