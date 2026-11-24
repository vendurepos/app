import { DefaultTaxZoneStrategy, type TaxZoneStrategy } from '@vendure/core';
/**
 * 5.2a: false only for exactly Vendure's DefaultTaxZoneStrategy (the channel's default zone, whatever the address),
 * by constructor and never `instanceof`: a subclass or a custom strategy may read the order's address.
 */
export function taxesByAddress(strategy: TaxZoneStrategy | undefined): boolean {
  return strategy?.constructor !== DefaultTaxZoneStrategy;
}
