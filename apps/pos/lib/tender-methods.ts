import { paymentMethodOf, type PaymentMethodDescriptor } from '@tallyui/core';
import { createLogger } from '@tallyui/pos';

// The order.create version that carries a payment's methodId (@tallyui/pos index.js:526,
// PAYMENT_METHOD_ID_ORDER_CREATE_VERSION). Below it a merchant tile's leg would land under tally-pos.
export const MIN_ORDER_CREATE_METHOD_ID = 10;
// The plugin's own limit on a methodId (value-ranges.ts text(), 64 characters).
const CODE_MAX = 64;
const KINDS = ['cash', 'card', 'other'];
// The plugin's MAX_CASH_ROUNDING_INCREMENT_MINOR; an increment of 1 rounds nothing.
const MAX_ROUNDING_INCREMENT = 100_000;
const ROUNDING_MODES = ['nearest', 'up', 'down'];

/** One of /tally/v1/info's paymentMethods entries, as the plugin lists them (payment-methods.service.ts). */
export type ListedTenderMethod = {
  code: string; name: string; kind: 'cash' | 'card' | 'other';
  /** A rounding cash method's cash rounding (ADR-094, plugin ADR 0009). */
  rounding?: { incrementMinor: number; mode: 'nearest' | 'up' | 'down' };
};

// A listed rounding the till can apply: a safe-integer increment from 2 to the plugin's limit, and a known mode.
const validRounding = (rounding: unknown): rounding is NonNullable<ListedTenderMethod['rounding']> => {
  const { incrementMinor, mode } = (rounding ?? {}) as Record<string, unknown>;
  return typeof incrementMinor === 'number' && Number.isSafeInteger(incrementMinor) && incrementMinor >= 2 &&
    incrementMinor <= MAX_ROUNDING_INCREMENT && typeof mode === 'string' && ROUNDING_MODES.includes(mode);
};

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
 * count), and a repeated code keeps its first entry. A cash entry's valid rounding becomes its `defaults.rounding`, which
 * TallyUI reads; an invalid one is ignored (logged as a count), and a rounding on any other kind is ignored.
 */
export function parseTenderMethods(body: unknown, orderCreate: number): PaymentMethodDescriptor[] | undefined {
  const listed = (body as { paymentMethods?: unknown } | null | undefined)?.paymentMethods;
  if (!Array.isArray(listed) || !(orderCreate >= MIN_ORDER_CREATE_METHOD_ID)) return undefined;
  const methods: PaymentMethodDescriptor[] = [];
  let unrounded = 0;
  for (const entry of listed.filter(usable)) {
    if (methods.some((method) => method.id === entry.code)) continue;
    const descriptor = paymentMethodOf(entry.kind === 'cash' ? 'cash' : 'external');
    const rounding = entry.kind === 'cash' ? entry.rounding : undefined;
    const valid = validRounding(rounding);
    if (rounding !== undefined && !valid) unrounded++;
    const defaults = valid ? { ...descriptor.defaults, rounding: { incrementMinor: rounding.incrementMinor, mode: rounding.mode } } : descriptor.defaults;
    methods.push({ ...descriptor, defaults, id: entry.code, title: entry.name, kind: entry.kind });
  }
  const dropped = listed.length - listed.filter(usable).length;
  if (dropped > 0) tenderMethodsLogger.warn(`Dropped ${dropped} of the store's payment methods that the till cannot offer`);
  if (unrounded > 0) tenderMethodsLogger.warn(`Ignored ${unrounded} of the store's cash roundings that the till cannot apply`);
  return methods.length ? methods : undefined;
}
