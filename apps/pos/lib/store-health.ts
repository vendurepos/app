import { isRequeueable, needsAttention, summarizeOutboxHealth, type OutboxState, type PosOrder } from '@tallyui/pos';

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

export type AttentionRow = { order: PosOrder; reason: string; retry: boolean };

/** Store health's "needs attention" records (CHECKLIST 10.3): the orders the Orders panel counts (needsAttention), each with
 * the outbox's reason, and Retry exactly where TallyUI's OrdersList offers it (a refused sale with a requeueable code). */
export function attentionRows(orders: PosOrder[], stuck: OutboxState['stuck']): AttentionRow[] {
  return needsAttention(orders, { stuckCommandIds: stuck?.commandIds }).map(order => {
    let reason: string;
    if (order.syncStatus === 'rejected') {
      reason = 'Refused by the store' + (order.error?.code ? ` — ${order.error.code}` : '');
    } else if (order.syncStatus === 'pending') {
      const entry = stuck?.orders.find((entry) => entry.commandId === order.commandId);
      reason = "Can't reach the store" + (entry ? ` — ${entry.reason}` : '');
    } else {
      reason = order.lateSessionId !== undefined ? 'Taken after the register closed' : 'Synced with a warning';
    }
    return { order, reason, retry: order.syncStatus === 'rejected' && isRequeueable(order.error?.code) };
  });
}
