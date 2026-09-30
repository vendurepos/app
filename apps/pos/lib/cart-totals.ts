import { taxLinesByRate, type Order } from '@tallyui/pos';

/**
 * The cart's figures: the order's display totals (TallyUI ADR-063) and its tax by rate, named by the store's rate.
 * An inclusive store's tax is already in the subtotal, so its rows read "incl." rather than add up.
 */
export function cartTotals(order: Order) {
  const { subtotalMinor, taxMinor, totalMinor, taxInclusive } = order.display;
  const incl = taxInclusive ? 'incl. ' : '';
  const taxRows = taxLinesByRate(order.lineItems, order.taxMinor, undefined, order.taxRounding).map(({ code, ratePpm, amountMinor }) => ({
    label: `${incl}${code ?? 'Tax'} ${ratePpm / 10_000}%`, amountMinor,
  }));
  return { subtotalMinor, taxMinor, totalMinor, taxLabel: `${incl}Tax`, taxRows };
}
