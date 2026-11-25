import { countsTowardPaid, isInMotion, type PaymentLegStatus } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';

/** Shown in ParkedSales when the discard is refused. */
export const PARKED_HOLDS_PAYMENT = 'This parked sale holds a payment, so it can’t be discarded. Resume it to finish the sale or cancel the payment.';
export const PARKED_UNREADABLE = 'This parked sale can’t be read, so it can’t be checked for payments and can’t be discarded.';

type Leg = { status?: PaymentLegStatus; locked?: boolean };

/** The draft's payment legs, or null when its data can't be read; no `payments` is a draft with none. */
function draftPayments(data: unknown): Leg[] | null {
  let saved: unknown;
  try { saved = JSON.parse(String(data)); } catch { return null; }
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return null;
  const { payments } = saved as { payments?: unknown };
  if (payments === undefined) return [];
  if (!Array.isArray(payments) || payments.some((leg) => typeof leg !== 'object' || leg === null)) return null;
  return payments as Leg[];
}

/**
 * Removes a parked sale, unless it holds a payment: the register's Z counts a parked sale's payment through its draft,
 * so removing the draft would take money already taken off the Z. A reopened sale's locked store legs don't stop it, as
 * in closeSale.
 */
export async function discardParkedSale(drafts: RxCollection, id: string): Promise<void> {
  const doc = await drafts.findOne(id).exec();
  if (!doc) return;
  const payments = draftPayments(doc.get('data'));
  if (!payments) throw new Error(PARKED_UNREADABLE);
  if (payments.some((leg) => !leg.locked && (countsTowardPaid(leg) || isInMotion(leg)))) {
    throw new Error(PARKED_HOLDS_PAYMENT);
  }
  await doc.remove();
}
