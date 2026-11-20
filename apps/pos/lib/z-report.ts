import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { buildClosureDocument, type Closure } from '@tallyui/pos';

// The document's words for a variance and a movement's type (ClosureContext.i18n).
export const I18N = { over: 'over', short: 'short', exact: 'exact', paid_in: 'Paid in', paid_out: 'Paid out', no_sale: 'No sale', void: 'Void' };

/** A tender as the till names it: `external` is the card terminal, as on the receipt. */
export const tenderName = (method: string) => method === 'cash' ? 'Cash' : method === 'external' ? 'Card' : method;

// The document carries decimal strings; an absent figure stays blank.
export const closureMoney = (currency: string) => (value: string): string =>
  value === '' ? '' : formatMoney({ amount: Math.round(Number(value) * 10 ** minorUnitDigits(currency)), currency }) ?? '';

// A figure the closure was frozen with prints; one it was frozen without (absent or null) prints no line, never 0.00.
const frozenLine = (minor: unknown, label: string, display: string): string[] =>
  typeof minor === 'number' && Number.isFinite(minor) ? [`${label} ${display}`] : [];

/**
 * The Z report as printed lines, from TallyUI's closure document (`buildClosureDocument`): every figure is the closure's
 * own, frozen by `writeClosure`, and nothing is recomputed here. The period's refunds and the register's perpetual totals print in v2's order, each only when the closure was frozen with it. The mixed tax rounding note is printed when the
 * document carries it (TallyUI #318).
 */
export function zReportLines(closure: Closure, { store, currency, timezone, printedAt }: {
  store: string; currency: string; timezone: string; printedAt: string;
}): string[] {
  const exponent = minorUnitDigits(currency);
  const { closure: z } = buildClosureDocument(closure, {
    store: { name: store }, currency, timezone, locale: 'en', printedAt, exponent, formatMoney: closureMoney(currency), i18n: I18N,
  });
  const { breakdowns } = z;
  return [
    `Z report · Closure #${closure.number}`,
    store,
    `Opened ${z.opened_at.datetime}`,
    `Closed ${z.closed_at.datetime}`,
    ...(typeof breakdowns.transaction_count === 'number' ? [`Sales ${breakdowns.transaction_count}`] : []),
    `Sales total ${z.period_sales_total_display}`,
    ...frozenLine(closure.period_refunds_total_minor, 'Refunds total', z.period_refunds_total_display),
    ...(typeof breakdowns.opening_float.counted_display === 'string' && breakdowns.opening_float.counted_display !== ''
      ? [`Opening float ${breakdowns.opening_float.counted_display}`] : []),
    ...breakdowns.payment_methods.map((method) => `${tenderName(String(method.name))} sales ${method.sales_display}`),
    ...breakdowns.tax_rates.map((rate) => `${String(rate.name)}: net ${rate.net_display}, tax ${rate.tax_display}, gross ${rate.gross_display}`),
    ...breakdowns.movements.map((movement) =>
      `${String(movement.type_label)} ${movement.amount_display} ${movement.reason}${movement.voided ? ' (voided)' : ''}`),
    ...z.tenders.flatMap((tender) => [
      `${tenderName(tender.name)} expected ${tender.expected_display}`,
      ...(tender.counted === '' ? [] : [`${tenderName(tender.name)} counted ${tender.counted_display}`,
        `${tenderName(tender.name)} variance ${tender.variance_display}`]),
    ]),
    ...frozenLine(closure.perpetual_sales_total_minor, 'Perpetual sales', z.perpetual_sales_total_display),
    ...frozenLine(closure.perpetual_refunds_total_minor, 'Perpetual refunds', z.perpetual_refunds_total_display),
    ...(typeof breakdowns.approved_by_name === 'string' && breakdowns.approved_by_name !== ''
      ? [`Approved by ${breakdowns.approved_by_name}`] : []),
    ...(closure.unsynced_count > 0 ? [unsyncedNote(closure.unsynced_count)] : []),
    ...(z.tax_rounding_note ? [z.tax_rounding_note] : []),
  ];
}

/**
 * The closure's orders not yet sent when it was written (its own `unsynced_count`): the closure waits for them
 * (lib/closure-hold.ts), so the store's view of this session lags the Z until they are sent.
 */
export const unsyncedNote = (count: number) => `${count} ${count === 1 ? 'order' : 'orders'} still syncing`;
