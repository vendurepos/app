import { countsTowardPaid, isInMotion, type PaymentLegStatus } from '@tallyui/pos';
import { useLayoutEffect } from 'react';

export type HeldLeg = { status?: PaymentLegStatus; locked?: boolean };

/** Whether the legs hold money this till took or is taking: an unlocked leg captured or in motion, TallyUI's closeSale rule. */
export function holdsPayment(legs: readonly HeldLeg[]): boolean {
  // A locked leg is a reopened store order's payment: the store has it, so nothing is lost with the sale.
  return legs.some((leg) => !leg.locked && (countsTowardPaid(leg) || isInMotion(leg)));
}

/** Reports whether the sale in progress holds a payment, and withdraws it when the sale unmounts. A completed sale (the receipt) holds none. */
export function useReportHeldPayment(
  sale: { stage: { kind: string }; order: { payments: readonly HeldLeg[] } },
  onHeldPayment: (held: boolean) => void,
): void {
  const held = sale.stage.kind !== 'receipt' && holdsPayment(sale.order.payments);
  // A layout effect, so the lock lands in the same commit as the leg and no click gets between them.
  useLayoutEffect(() => {
    onHeldPayment(held);
    return () => onHeldPayment(false);
  }, [held, onHeldPayment]);
}
