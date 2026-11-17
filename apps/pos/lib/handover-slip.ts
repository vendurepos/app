import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { handoverSlip, type OutboxHealth, type RegisterSession } from '@tallyui/pos';
import { closureMoney, I18N, tenderName } from './z-report';

/** The hand-over slip (TallyUI `handoverSlip`, the open session's X report naming the cashier) as printed lines, as TallyUI's on-screen `HandoverSlip` shows it. */
export function handoverSlipLines(
  { session, expected, salesCount, blind }: { session: RegisterSession; expected: Record<string, number>; salesCount: number; blind: boolean },
  { store, currency, timezone, printedAt, cashier, outbox }: {
    store: string; currency: string; timezone: string; printedAt: string; cashier: string; outbox: Pick<OutboxHealth, 'sales' | 'tillUpdates'>;
  },
): string[] {
  // 'Register': a single-register store has no register name, as the register panel's title (CHECKLIST 6.2/6.6).
  const slip = handoverSlip({ session, cashier: { name: cashier }, registerName: 'Register', openedByName: session.opened_by ?? '', salesCount, expected, blind, outbox, context: { store: { name: store }, currency, timezone, locale: 'en', printedAt, exponent: minorUnitDigits(currency), formatMoney: closureMoney(currency), i18n: I18N } });
  const count = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;
  return [
    'Hand-over slip',
    store,
    [slip.registerName, slip.openedAtTime && `open since ${slip.openedAtTime}`, slip.openedByName].filter(Boolean).join(' · '),
    `Printed ${slip.document.order.printed.datetime}`,
    `Handed over by ${slip.cashierName}`,
    count(slip.salesCount, 'sale', 'sales'),
    ...Object.entries(slip.expected ?? {}).map(([method, amount]) => `Expected ${tenderName(method)} ${formatMoney({ amount, currency }) ?? ''}`),
    ...(slip.unsentSales > 0 ? [count(slip.unsentSales, 'unsent sale', 'unsent sales')] : []),
    ...(slip.unsentTillUpdates > 0 ? [count(slip.unsentTillUpdates, 'unsent till update', 'unsent till updates')] : []),
  ];
}
