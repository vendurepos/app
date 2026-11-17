import type { StoreSettings } from '@tallyui/core';

export type TaxRateRow = { key: string; name: string; rate: string };

/** A ppm rate as a percent, without trailing zeros: 190000 → "19 %", 55000 → "5.5 %", 0 → "0 %". */
export function percentOfPpm(ppm: number): string {
  return `${Number((ppm / 10_000).toFixed(4))} %`;
}

/** The zone's rates by tax category (every taxRatesPpm key but `default`), highest rate first, then by name. */
export function taxRateRows(settings: StoreSettings): TaxRateRow[] {
  return Object.entries(settings.taxRatesPpm)
    .filter(([key]) => key !== 'default')
    .map(([key, ppm]) => ({ key, ppm, name: settings.taxRateCodes?.[key] ?? `Tax category ${key}` }))
    .sort((a, b) => b.ppm - a.ppm || a.name.localeCompare(b.name))
    .map(({ key, ppm, name }) => ({ key, name, rate: percentOfPpm(ppm) }));
}
