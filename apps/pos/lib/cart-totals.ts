import { taxLinesByRate, type Order } from '@tallyui/pos';

/** A tax row's name: the store's rate code and percentage. An inclusive store's tax is already in the subtotal, so it reads "incl.". */
export function taxRowLabel(taxInclusive: boolean, code: string | undefined, ratePpm: number): string {
  return `${taxInclusive ? 'incl. ' : ''}${code ?? 'Tax'} ${ratePpm / 10_000}%`;
}

/** The cart's figures: the order's display totals (TallyUI ADR-063) and its tax by rate, named by the store's rate. */
export function cartTotals(order: Order) {
  const { subtotalMinor, taxMinor, totalMinor, taxInclusive } = order.display;
  const taxRows = taxLinesByRate(order.lineItems, order.taxMinor, undefined, order.taxRounding).map(({ code, ratePpm, amountMinor }) => ({
    label: taxRowLabel(taxInclusive, code, ratePpm), name: taxRowLabel(false, code, ratePpm), amountMinor,
  }));
  return { subtotalMinor, taxMinor, totalMinor, taxLabel: `${taxInclusive ? 'incl. ' : ''}Tax`, taxRows };
}
