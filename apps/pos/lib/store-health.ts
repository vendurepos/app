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

/** Storage used in bytes, scaled in steps of 1024. */
export function formatStorageUsed(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A collection's measured size: undefined while measuring (…), null when unmeasurable (—), else ≈ its storage size. */
export function formatCollectionSize(bytes: number | null | undefined): string {
  if (bytes === undefined) return '…';
  if (bytes === null) return '—';
  return bytes === 0 ? '0 B' : `≈ ${formatStorageUsed(bytes)}`;
}

/** Browser storage used for this origin, or null when its estimate is unavailable. */
export async function readStorageUsed(storage: { estimate?: () => Promise<{ usage?: number }> } | undefined): Promise<number | null> {
  if (!storage?.estimate) return null;
  try {
    const { usage } = await storage.estimate();
    return typeof usage === 'number' && Number.isFinite(usage) && usage >= 0 ? usage : null;
  } catch {
    return null;
  }
}

/** Coverage (CHECKLIST 10.3): on device ÷ on server as a whole percent, at most 100, and 100 when the store has none;
 * null when either figure is unknown. */
export function coveragePercent(onDevice: number | null, onServer: number | null): number | null {
  if (onDevice === null || onServer === null) return null;
  return onServer === 0 ? 100 : Math.min(100, Math.round(onDevice / onServer * 100));
}

export type ServerTotals = { products: number | null; variants: number | null; orders: number | null };

// Unnamed, so the demo store (lib/demo/fetch.ts) answers them as `products` and `productVariants`.
const PRODUCT_TOTAL_QUERY = 'query ($options: ProductListOptions) { products(options: $options) { totalItems } }';
const VARIANT_TOTAL_QUERY = 'query ($options: ProductVariantListOptions) { productVariants(options: $options) { totalItems } }';

/** Store health's On server column: one read each of the store's product, variant and order totals (the Orders panel's
 * `orders` list total). Each is null when its read fails: offline, refused or an unexpected answer. */
export async function readServerTotals(context: SyncContext): Promise<ServerTotals> {
  const total = (query: string, field: 'products' | 'productVariants') => fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query, variables: { options: { take: 1 } } }),
  }).then(async response => {
    const total = response.ok ? (await response.json())?.data?.[field]?.totalItems : undefined;
    return typeof total === 'number' ? total : null;
  }).catch(() => null);
  const orders = listVendureOrders(context, { take: 1 }).then(list => list.totalItems).catch(() => null);
  const [productTotal, variantTotal, orderTotal] = await Promise.all([total(PRODUCT_TOTAL_QUERY, 'products'), total(VARIANT_TOTAL_QUERY, 'productVariants'), orders]);
  return { products: productTotal, variants: variantTotal, orders: orderTotal };
}

export type AttentionRow = { order: PosOrder; reason: string; retry: boolean; rescue: boolean };

export const TAX_ZONE_REFUSED_TEXT = "Refused by the store — the customer's address is in another tax zone. Send it without the address.";
/** The plugin's refusal of a sale whose address moves the tax zone (5.2a): it goes again only without its address (sendWithoutAddress). */
export const canSendWithoutAddress = (order: Pick<PosOrder, 'syncStatus' | 'error'>): boolean => order.syncStatus === 'rejected' && order.error?.code === 'tax_zone_mismatch';
/** A refused sale that Retry can fix: a requeueable code, where TallyUI's OrdersList offers Retry, but for tax_zone_mismatch. */
export const canSendAgain = (order: PosOrder): boolean => order.syncStatus === 'rejected' && isRequeueable(order.error?.code) && !canSendWithoutAddress(order);

const FIELD_PATH = /^[A-Za-z_]\w*(\[\d+\])?(\.[A-Za-z_]\w*(\[\d+\])?)*$/;

const refusedHead = (part: string): string | undefined => part.includes(': ') ? part.slice(0, part.indexOf(': '))
  : part.includes(' must ') ? part.slice(0, part.indexOf(' must ')) : undefined;

/** An `invalid_payload` refusal's field paths, deduped, at most 3. Its message is `; `-joined items, each
 * `<path>: <reason>` or `<path> must …` (the clock refusals); nulPath's dotted indexes (`lines.0`) read as `lines[0]`.
 * Only the path is ever returned: the reason after it is the server's text. */
export function refusedFields(error: { code?: string; message?: string } | undefined): string[] {
  if (error?.code !== 'invalid_payload' || !error.message) return [];
  const paths = error.message.split('; ').map(refusedHead).filter((head): head is string => head !== undefined)
    .map(head => head.replace(/\.(\d+)(?=\.|$)/g, '[$1]'));
  return [...new Set(paths.filter(path => FIELD_PATH.test(path)))].slice(0, 3);
}

/** Why an order needs attention, in Store health's words; `stuck` gives a pending sale's reason. */
export function attentionReason(order: PosOrder, stuck?: OutboxState['stuck']): string {
  const entry = stuck?.orders.find((entry) => entry.commandId === order.commandId);
  if (canSendWithoutAddress(order)) return TAX_ZONE_REFUSED_TEXT;
  if (order.syncStatus === 'rejected') {
    const fields = refusedFields(order.error);
    return 'Refused by the store' + (order.error?.code ? ` — ${order.error.code}` : '') + (fields.length ? `: ${fields.join(', ')}` : '');
  }
  if (order.syncStatus === 'pending') return "Can't reach the store" + (entry ? ` — ${entry.reason}` : '');
  return order.lateSessionId !== undefined ? 'Taken after the register closed' : 'Synced with a warning';
}

/** Store health's "needs attention" records (CHECKLIST 10.3): the orders the Orders panel counts (needsAttention), each with
 * the outbox's reason, and Retry exactly where TallyUI's OrdersList offers it (a refused sale with a requeueable code).
 * As in needsAttention, the connector's discountsAreTaxedRows flag tells ADR-048's T to count discounted lines. */
export function attentionRows(orders: PosOrder[], stuck: OutboxState['stuck'], discountsAreTaxedRows = false): AttentionRow[] {
  return needsAttention(orders, { stuckCommandIds: stuck?.commandIds, discountsAreTaxedRows }).map(order => ({ order, reason: attentionReason(order, stuck), retry: canSendAgain(order), rescue: canSendWithoutAddress(order) }));
}

/** Clear & re-download's confirm (CHECKLIST 10.3): how many products leave this device and download again from the store. */
export function redownloadSummary(count: number): string {
  if (count === 0) return 'No products are on this device yet; they download again from your store.';
  return `${count} ${count === 1 ? 'product is' : 'products are'} removed from this device and downloaded again from your store.`;
}

/** Why Clear & re-download is off: mid-run, or the store has not answered (an offline till must not clear what it cannot re-download). */
export function redownloadBlocked(redownloading: boolean, serverProducts: number | null): string | null {
  if (redownloading) return 'Re-downloading…';
  if (serverProducts === null) return 'Needs your store to answer, so the products can download again.';
  return null;
}

/** Clear & re-download's Yes asks the store again, so a till that went offline after the panel opened keeps its catalogue;
 * a Cancel while the store is checked (stillWanted false when it answers) keeps it too. */
export async function confirmRedownload(
  readTotals: () => Promise<ServerTotals>,
  onTotals: (totals: ServerTotals) => void,
  onRedownload: () => Promise<void>,
  stillWanted: () => boolean,
): Promise<'cleared' | 'refused'> {
  const totals = await readTotals();
  onTotals(totals);
  if (totals.products === null) return 'refused';
  if (!stillWanted()) return 'refused';
  await onRedownload();
  return 'cleared';
}
