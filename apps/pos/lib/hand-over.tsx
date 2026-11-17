import type { JSX } from 'react';
import { SwitchConfirm } from '@tallyui/components';
import { switchWarnings, type OutboxHealth, type useRegisterSession } from '@tallyui/pos';
import { handoverSlipLines } from './handover-slip';
import { printLines } from './print-lines';

/**
 * Hand the till to another account (CHECKLIST 6.1, v2's "Hand the till to"): a cashier is a Vendure administrator, so
 * the hand-over signs this account out and leaves the register session open for whoever signs in next.
 */
export function HandOverConfirm({ register, outbox, parkedSales, paidMinor, store, currency, timezone, cashier, disabled, onCancel, onSignOut }: {
  register: ReturnType<typeof useRegisterSession>; outbox: OutboxHealth; parkedSales: number; paidMinor: number;
  store: string; currency: string; timezone: string; cashier: string;
  /** Sign out is locked (lib/sign-out-lock.ts) or already under way: the confirm does nothing, as Sign out's button. */
  disabled: boolean; onCancel(): void; onSignOut(): void;
}): JSX.Element {
  const warnings = switchWarnings({ kind: 'cashier', outbox, parkedSales, paidMinor, sessionStatus: register.session?.status ?? null });
  const printHandover = () => {
    // A failed print leaves the dialog as it was, and the cashier can print again or hand over.
    if (register.session) void printLines('Hand-over slip', handoverSlipLines(
      { session: register.session, expected: register.expected, salesCount: register.salesCount, blind: register.blind }, { store, currency, timezone, printedAt: new Date().toISOString(), cashier, outbox },
    )).catch(() => undefined);
  };
  return <SwitchConfirm kind="cashier" warnings={warnings} targetName="another account" registerName="Register" onConfirm={() => { if (!disabled) onSignOut(); }} onCancel={onCancel} onPrintHandover={printHandover} />;
}
