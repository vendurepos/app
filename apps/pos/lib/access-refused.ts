import type { OutboxState } from '@tallyui/pos';
import { POS_ACCESS_REFUSED_TEXT } from './sign-in';

/** ADR 0023: a later 403 signs the till in again like a 401, with the sign-in words. */
export function accessRefused(catalogueError: string | null, ...outboxes: OutboxState[]): boolean {
  return catalogueError === POS_ACCESS_REFUSED_TEXT || outboxes.some(({ refused }) => refused?.status === 403);
}
