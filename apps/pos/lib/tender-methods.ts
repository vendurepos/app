import { paymentMethodOf, type PaymentMethodDescriptor } from '@tallyui/core';
import { createLogger } from '@tallyui/pos';

// The order.create version that carries a payment's methodId (@tallyui/pos index.js:526,
// PAYMENT_METHOD_ID_ORDER_CREATE_VERSION). Below it a merchant tile's leg would land under tally-pos.
export const MIN_ORDER_CREATE_METHOD_ID = 10;
// The plugin's own limit on a methodId (value-ranges.ts text(), 64 characters).
const CODE_MAX = 64;
const KINDS = ['cash', 'card', 'other'];

/** One of /tally/v1/info's paymentMethods entries, as the plugin lists them (payment-methods.service.ts). */
export type ListedTenderMethod = { code: string; name: string; kind: 'cash' | 'card' | 'other' };

/** The till's tender methods: entries it dropped, by count only. */
export const tenderMethodsLogger = createLogger('tender-methods');

const usable = (entry: unknown): entry is ListedTenderMethod => {
  const { code, name, kind } = (entry ?? {}) as Record<string, unknown>;
  return typeof code === 'string' && code.length > 0 && code.length <= CODE_MAX && !code.includes('\0') &&
    typeof name === 'string' && name.length > 0 && typeof kind === 'string' && KINDS.includes(kind);
};

/**
 * The store's Tally POS payment methods as TenderPane descriptors, or undefined for the default tiles: when /info lists
 * none, or the store's order.create is below MIN_ORDER_CREATE_METHOD_ID. A malformed entry is dropped (logged as a
 * count), and a repeated code keeps its first entry.
 */
export function parseTenderMethods(body: unknown, orderCreate: number): PaymentMethodDescriptor[] | undefined {
  const listed = (body as { paymentMethods?: unknown } | null | undefined)?.paymentMethods;
  if (!Array.isArray(listed) || !(orderCreate >= MIN_ORDER_CREATE_METHOD_ID)) return undefined;
  const methods: PaymentMethodDescriptor[] = [];
  for (const entry of listed.filter(usable)) {
    if (methods.some((method) => method.id === entry.code)) continue;
    methods.push({ ...paymentMethodOf(entry.kind === 'cash' ? 'cash' : 'external'), id: entry.code, title: entry.name, kind: entry.kind });
  }
  const dropped = listed.length - listed.filter(usable).length;
  if (dropped > 0) tenderMethodsLogger.warn(`Dropped ${dropped} of the store's payment methods that the till cannot offer`);
  return methods.length ? methods : undefined;
}
