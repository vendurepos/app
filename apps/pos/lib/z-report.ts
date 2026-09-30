import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { buildClosureDocument, type Closure } from '@tallyui/pos';

// The document's words for a variance and a movement's type (ClosureContext.i18n).
const I18N = { over: 'over', short: 'short', exact: 'exact', paid_in: 'Paid in', paid_out: 'Paid out', no_sale: 'No sale', void: 'Void' };

/** A tender as the till names it: `external` is the card terminal, as on the receipt. */
const tenderName = (method: string) => method === 'cash' ? 'Cash' : method === 'external' ? 'Card' : method;

/**
 * The Z report as printed lines, from TallyUI's closure document (`buildClosureDocument`): every figure is the closure's
 * own, frozen by `writeClosure`, and nothing is recomputed here. The mixed tax rounding note is printed when the
 * document carries it (TallyUI #318).
 */
export function zReportLines(closure: Closure, { store, currency, timezone, printedAt }: {
  store: string; currency: string; timezone: string; printedAt: string;
}): string[] {
  const exponent = minorUnitDigits(currency);
  // The document carries decimal strings; an absent figure stays blank.
  const money = (value: string) => value === '' ? '' : formatMoney({ amount: Math.round(Number(value) * 10 ** exponent), currency }) ?? '';
  const { closure: z } = buildClosureDocument(closure, {
    store: { name: store }, currency, timezone, locale: 'en', printedAt, exponent, formatMoney: money, i18n: I18N,
  });
  const { breakdowns } = z;
  return [
    `Z report · Closure #${closure.number}`,
    store,
    `Opened ${z.opened_at.datetime}`,
    `Closed ${z.closed_at.datetime}`,
    `Sales ${breakdowns.transaction_count as number}`,
    `Sales total ${z.period_sales_total_display}`,
    `Opening float ${breakdowns.opening_float.counted_display}`,
    ...breakdowns.payment_methods.map((method) => `${tenderName(String(method.name))} sales ${method.sales_display}`),
    ...breakdowns.tax_rates.map((rate) => `${String(rate.name)}: net ${rate.net_display}, tax ${rate.tax_display}, gross ${rate.gross_display}`),
    ...breakdowns.movements.map((movement) =>
      `${String(movement.type_label)} ${movement.amount_display} ${movement.reason}${movement.voided ? ' (voided)' : ''}`),
    ...z.tenders.flatMap((tender) => [
      `${tenderName(tender.name)} expected ${tender.expected_display}`,
      ...(tender.counted === '' ? [] : [`${tenderName(tender.name)} counted ${tender.counted_display}`,
        `${tenderName(tender.name)} variance ${tender.variance_display}`]),
    ]),
    ...(z.tax_rounding_note ? [z.tax_rounding_note] : []),
  ];
}
