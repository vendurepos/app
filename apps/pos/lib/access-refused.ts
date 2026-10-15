import type { OutboxState } from '@tallyui/pos';
import type { CatalogueRefusal } from './catalogue-status';

/** ADR 0023: a later 403 signs the till in again like a 401, with the sign-in words. */
export function accessRefused(refusal: CatalogueRefusal | null, ...outboxes: OutboxState[]): boolean {
  return refusal === 'access_refused' || outboxes.some(({ refused }) => refused?.status === 403);
}
