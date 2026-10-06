import { taxLinesByRate, type Order } from '@tallyui/pos';

/** A tax row's name: the store's rate code and percentage. An inclusive store's tax is already in the subtotal, so it reads "incl.". */
export function taxRowLabel(taxInclusive: boolean, code: string | undefined, ratePpm: number): string {
  return `${taxInclusive ? 'incl. ' : ''}${code ?? 'Tax'} ${ratePpm / 10_000}%`;
}

/**
 * The cart's figures: the order's display totals (TallyUI ADR-063) and its tax by rate, named by the store's rate: `label`
 * as the rate's testID has it, `name` as the row under Tax reads it.
 */
export function cartTotals(order: Order) {
  const { subtotalMinor, taxMinor, totalMinor, taxInclusive } = order.display;
  const taxedLines = [...order.lineItems, ...[...(order.fees ?? []), ...(order.shipping ?? [])].map((charge) => ({ ...charge, taxInclusive: order.pricesIncludeTax }))];
  const taxRows = taxLinesByRate(taxedLines, order.taxMinor, undefined, order.taxRounding).map(({ code, ratePpm, amountMinor }) => ({
    label: taxRowLabel(taxInclusive, code, ratePpm), name: taxRowLabel(false, code, ratePpm), amountMinor,
  }));
  return { subtotalMinor, taxMinor, totalMinor, taxLabel: `${taxInclusive ? 'incl. ' : ''}Tax`, taxRows };
}

/**
 * The store's tax categories, offered as ChargeForm's tax classes. The till's tax context and the plugin resolve
 * the id (ADR 0005 point 4). Leave out `default`: "No class" already means the default category.
 */
export function chargeTaxClasses(taxRateCodes: Record<string, string> | undefined): { id: string; label: string }[] {
  return Object.entries(taxRateCodes ?? {}).filter(([id]) => id !== 'default').map(([id, label]) => ({ id, label }));
}

/** The narrow layout's Cart tab: the item count (the sum of quantities) and the total, formatted as the cart formats it. */
export function cartTabLabel(order: Order, format: (money: { amount: number; currency: string }) => string): string {
  const count = order.lineItems.reduce((sum, line) => sum + line.quantity, 0);
  return `Cart (${count}) · ${format({ amount: order.display.totalMinor, currency: order.currency })}`;
}
