import { minorUnitDigits } from '@tallyui/core';
import { buildXReportDocument, minorToDecimal, type CashMovement, type RegisterSession } from '@tallyui/pos';
import { closureMoney, I18N, tenderName } from './z-report';

export function xReportLines(
  { session, expected, movements, salesCount, blind }: {
    session: RegisterSession; expected: Record<string, number>; movements: readonly CashMovement[]; salesCount: number; blind: boolean;
  },
  { store, currency, timezone, printedAt }: { store: string; currency: string; timezone: string; printedAt: string },
): string[] {
  const exponent = minorUnitDigits(currency);
  const { closure, order } = buildXReportDocument(session, {
    store: { name: store }, currency, timezone, locale: 'en', printedAt, exponent, formatMoney: closureMoney(currency), i18n: I18N,
    expected: blind ? {} : expected,
    breakdowns: {
      movements: movements.map((m) => ({ ...m, amount: minorToDecimal(m.amountMinor, exponent) })),
      transaction_count: salesCount,
    },
  });
  const { breakdowns } = closure;
  return [
    'X report · Register open',
    store,
    `Opened ${closure.opened_at.datetime}`,
    `Printed ${order.printed.datetime}`,
    `Sales ${breakdowns.transaction_count as number}`,
    `Opening float ${breakdowns.opening_float.counted_display}`,
    ...breakdowns.movements.map((movement) =>
      `${String(movement.type_label)} ${movement.amount_display} ${movement.reason}${movement.voided ? ' (voided)' : ''}`),
    ...closure.tenders.map((tender) => `${tenderName(tender.name)} expected ${tender.expected_display}`),
  ];
}
