import { switchWarnings } from '@tallyui/pos';

// Outbox counts are zero because the close already waits for unsent sales (lib/closure-hold.ts).
const ZERO_OUTBOX = { sales: { pending: 0, rejected: 0, stuck: 0 }, tillUpdates: { pending: 0, rejected: 0, stuck: 0 } };

/**
 * What a register close leaves behind on this till (AUDIT §4, v2's close warnings): parked sales and a partly paid
 * sale, in SwitchConfirm's words. Unsent sales are left out: the close already waits for them (lib/closure-hold.ts).
 */
export function closeWarningLines(parkedSales: number, paidMinor: number): { code: 'parkedSales' | 'partlyPaidSale'; text: string }[] {
  return switchWarnings({ kind: 'register', outbox: ZERO_OUTBOX, parkedSales, paidMinor, sessionStatus: null }).warnings
    .filter((warning) => warning.code === 'parkedSales' || warning.code === 'partlyPaidSale')
    .map((warning) => ({
      code: warning.code,
      text: warning.code === 'parkedSales' ? `${warning.count} parked sale${warning.count === 1 ? '' : 's'}` : 'A sale is partly paid',
    }));
}
