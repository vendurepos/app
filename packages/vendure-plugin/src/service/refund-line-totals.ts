import type { ID } from '@vendure/core';
import { TALLY_DISCOUNT_SKU } from './constants';

// #460, desk ruling 2: an order whose discounts have no line link, refunded one line at a time, is refused, never guessed.
export const REFUND_DISCOUNT_UNLINKED_MESSAGE =
  "This order's discounts were recorded before they were linked to its lines, so one line of it can't be refunded at the till. Refund everything left on the order, or refund it in Vendure.";

type RefundLine = { id: ID; quantity: number; proratedLinePriceWithTax: number };
type RefundOrder<L> = {
  lines: L[]; surcharges: Array<{ id: ID; sku: string; priceWithTax: number }>; customFields: { tallySnapshot?: string | null };
};

/** #460: each line's total with tax after its till discount (a TALLY_DISCOUNT_SKU surcharge), for the refund to prorate. */
export function lineTotalsForRefund<L extends RefundLine>(order: RefundOrder<L>, payloadLines: Array<{ line: L; quantity: number }>,
  refundedOf: (line: L) => number, previousHadLines: boolean): { totals: Map<ID, number> } | { refuse: true } {
  const totals = new Map<ID, number>(order.lines.map(line => [line.id, line.proratedLinePriceWithTax]));
  const discounts = order.surcharges.filter(surcharge => surcharge.sku === TALLY_DISCOUNT_SKU);
  if (!discounts.length) return { totals };
  let links: unknown;
  try {
    links = JSON.parse(order.customFields.tallySnapshot ?? '').lineDiscounts;
  } catch { /* unparsable: unlinked */ }
  if (typeof links === 'object' && links !== null && !Array.isArray(links)) {
    for (const [lineId, surchargeId] of Object.entries(links)) {
      const surcharge = discounts.find(item => String(item.id) === String(surchargeId));
      if (!surcharge) return { refuse: true };
      const line = order.lines.find(item => String(item.id) === lineId);
      if (line) totals.set(line.id, line.proratedLinePriceWithTax + surcharge.priceWithTax);
    }
    return { totals };
  }
  const discountSum = discounts.reduce((sum, surcharge) => sum + surcharge.priceWithTax, 0);
  if (order.lines.length === 1) return { totals: totals.set(order.lines[0].id, order.lines[0].proratedLinePriceWithTax + discountSum) };
  const whole = !previousHadLines && order.lines.every(line => line.quantity - refundedOf(line)
    === payloadLines.filter(item => String(item.line.id) === String(line.id)).reduce((sum, item) => sum + item.quantity, 0));
  if (!whole || !payloadLines.length) return { refuse: true };
  // Everything left is refunded together, so the discounts go with the order's lines as a whole: the line part is
  // sum(proratedLinePriceWithTax) + sum(discounts). Only in this case, the whole sum sits on the refunded line with the highest id.
  const last = payloadLines.map(item => item.line)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true })).at(-1)!;
  return { totals: totals.set(last.id, last.proratedLinePriceWithTax + discountSum) };
}
