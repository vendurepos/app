import { listVendureOrders } from '@tallyui/connector-vendure';
import type { SyncContext } from '@tallyui/core';
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

/** Coverage (CHECKLIST 10.3): on device ÷ on server as a whole percent, at most 100, and 100 when the store has none;
 * null when either figure is unknown. */
export function coveragePercent(onDevice: number | null, onServer: number | null): number | null {
  if (onDevice === null || onServer === null) return null;
  return onServer === 0 ? 100 : Math.min(100, Math.round(onDevice / onServer * 100));
}

export type ServerTotals = { products: number | null; orders: number | null };

// Unnamed, so the demo store (lib/demo/fetch.ts) answers it as `products`.
const PRODUCT_TOTAL_QUERY = 'query ($options: ProductListOptions) { products(options: $options) { totalItems } }';

/** Store health's On server column: one read of the store's product total and order total (the Orders panel's
 * `orders` list total). Each is null when its read fails: offline, refused or an unexpected answer. */
export async function readServerTotals(context: SyncContext): Promise<ServerTotals> {
  const products = fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: PRODUCT_TOTAL_QUERY, variables: { options: { take: 1 } } }),
  }).then(async response => {
    const total = response.ok ? (await response.json())?.data?.products?.totalItems : undefined;
    return typeof total === 'number' ? total : null;
  }).catch(() => null);
  const orders = listVendureOrders(context, { take: 1 }).then(list => list.totalItems).catch(() => null);
  const [productTotal, orderTotal] = await Promise.all([products, orders]);
  return { products: productTotal, orders: orderTotal };
}

export type AttentionRow = { order: PosOrder; reason: string; retry: boolean };

/** A refused sale that Retry can fix: a requeueable code, exactly where TallyUI's OrdersList offers Retry. */
export const canSendAgain = (order: PosOrder): boolean => order.syncStatus === 'rejected' && isRequeueable(order.error?.code);

/** Why an order needs attention, in Store health's words; `stuck` gives a pending sale's reason. */
export function attentionReason(order: PosOrder, stuck?: OutboxState['stuck']): string {
  const entry = stuck?.orders.find((entry) => entry.commandId === order.commandId);
  if (order.syncStatus === 'rejected') return 'Refused by the store' + (order.error?.code ? ` — ${order.error.code}` : '');
  if (order.syncStatus === 'pending') return "Can't reach the store" + (entry ? ` — ${entry.reason}` : '');
  return order.lateSessionId !== undefined ? 'Taken after the register closed' : 'Synced with a warning';
}

/** Store health's "needs attention" records (CHECKLIST 10.3): the orders the Orders panel counts (needsAttention), each with
 * the outbox's reason, and Retry exactly where TallyUI's OrdersList offers it (a refused sale with a requeueable code). */
export function attentionRows(orders: PosOrder[], stuck: OutboxState['stuck']): AttentionRow[] {
  return needsAttention(orders, { stuckCommandIds: stuck?.commandIds }).map(order => ({ order, reason: attentionReason(order, stuck), retry: canSendAgain(order) }));
}

/** Clear & re-download's confirm (CHECKLIST 10.3): how many products leave this device and download again from the store. */
export function redownloadSummary(count: number): string {
  if (count === 0) return 'No products are on this device yet; they download again from your store.';
  return `${count} ${count === 1 ? 'product is' : 'products are'} removed from this device and downloaded again from your store.`;
}
