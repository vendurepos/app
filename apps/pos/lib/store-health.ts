import { summarizeOutboxHealth, type OutboxState } from '@tallyui/pos';

export type ReadyToSell = { ready: true } | { ready: false; reason: string };

/** Store health's "Ready to sell" (CHECKLIST 10.3): a sale can be taken and kept on this device, whether or not the store answers. */
export function readyToSell(facts: { catalogueSynced: boolean; signedOut: boolean; settingsReady: boolean; ordersOpen: boolean }): ReadyToSell {
  if (facts.signedOut) return { ready: false, reason: 'The store refused this sign-in' };
  if (!facts.catalogueSynced) return { ready: false, reason: 'The catalogue has not synced yet' };
  if (!facts.settingsReady) return { ready: false, reason: "The store's settings are not read yet" };
  if (!facts.ordersOpen) return { ready: false, reason: 'The order store is not open yet' };
  return { ready: true };
}

/** Changes waiting to send: sales plus till updates still pending in their outboxes. */
export function changesWaiting(sales: OutboxState, tillUpdates: OutboxState): number {
  const health = summarizeOutboxHealth(sales, tillUpdates);
  return health.sales.pending + health.tillUpdates.pending;
}

/** Records on this device: the sum of the counts, a count not read yet (null) as 0. */
export function recordsOnDevice(counts: readonly (number | null)[]): number {
  return counts.reduce<number>((total, count) => total + (count ?? 0), 0);
}
