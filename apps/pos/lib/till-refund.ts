import { vendureLineRefundWithTax, vendureRefundable, type VendureOrder } from '@tallyui/connector-vendure';
import { ConnectorUnauthorizedError, formatMoney, type OrderRefundEnvelope, type OrderRefundPayload, type SyncContext } from '@tallyui/core';
import {
  mintUuid, RefundAnswerPendingError, refundNeedsAdminLine, submitOrderRefund,
  type CommandTransport, type OrderRefundOutcome, type PosRefund, type PosRefundCollection,
} from '@tallyui/pos';
import { orderStateLabel } from './order-history';

export type RefundTill = { sessionId: string; registerId: string; deviceId: string; cashierRef: string };
export type RefundDraft = { quantities: Readonly<Record<string, number>>; reason: string; restock: boolean };

export const REFUND_NOTHING_TEXT = 'Pick at least one item to refund.';
export const REFUND_QUANTITY_EXCEEDS_TEXT = 'Some of these items have already been refunded. Check the quantities and try again.';
export const REFUND_AMOUNT_MISMATCH_TEXT =
  'The store worked out a different refund amount, so nothing was refunded. Open the order again and retry.';
export const REFUND_NOT_TILL_ORDER_TEXT = 'Only sales made on a till can be refunded here.';
export const REFUND_FORBIDDEN_TEXT = "This account can't refund. Ask the store's admin to add the TallyPosRefund permission to its role.";
export const REFUND_NO_SESSION_TEXT = 'The store has no open register session for this till. Open the register, then try again.';
export const REFUND_UNKNOWN_TEXT = "The store hasn't answered yet. Don't hand back cash until it confirms. Send the refund again: it is never refunded twice.";
export const REFUND_UNAUTHORIZED_TEXT = 'Your session has ended. Sign in again, then send the refund again.';
// The plugin's REFUND_DISCOUNT_UNLINKED_MESSAGE (#460), word for word.
export const REFUND_DISCOUNT_UNLINKED_TEXT =
  "This order's discounts were recorded before they were linked to its lines, so one line of it can't be refunded at the till. Refund everything left on the order, or refund it in Vendure.";
// The plugin's REFUND_ROUNDING_EXCEEDS_MESSAGE (#469), word for word.
export const REFUND_ROUNDING_EXCEEDS_TEXT =
  "This order's rounding is more than what is left to refund on it, so the rest can't be refunded at the till. Refund the rest in Vendure admin, by amount.";
export const REFUND_PENDING_TEXT = "The store hasn't answered the last refund for this order yet. Don't hand back cash until it confirms. Send it again before starting a new one.";

export type RefundDiscount = { id: string; priceWithTax: number };
/** getVendureOrder's order with its TALLY-DISCOUNT surcharges' ids (fetchTillDiscounts), which the connector leaves out. */
export type TillOrder = VendureOrder & { tallyDiscounts?: RefundDiscount[] };
// The plugin's TALLY_DISCOUNT_SKU (packages/vendure-plugin/src/service/constants.ts): the surcharge of a till line discount.
export const TALLY_DISCOUNT_SKU = 'TALLY-DISCOUNT';
// The plugin's TALLY_ROUNDING_SKU (packages/vendure-plugin/src/service/constants.ts): the "POS rounding" bridge.
export const TALLY_ROUNDING_SKU = 'TALLY-ROUNDING';
// The plugin's TALLY_CASH_ROUNDING_SKU (packages/vendure-plugin/src/service/constants.ts): a cash leg's rounding (ADR-094).
export const TALLY_CASH_ROUNDING_SKU = 'TALLY-CASH-ROUNDING';

/** The order's TALLY-DISCOUNT surcharges with their ids; [] for no order. */
export async function fetchTillDiscounts(context: SyncContext, orderId: string): Promise<RefundDiscount[]> {
  const query = `query TillDiscounts($id: ID!) { order(id: $id) { surcharges { id sku priceWithTax } } }`;
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query, variables: { id: orderId } }),
  });
  if (response.status === 401 || response.status === 403) throw new ConnectorUnauthorizedError(`Vendure API error: ${response.status}`, response.status);
  if (!response.ok) throw new Error(`Vendure API error: ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw body.errors[0].extensions?.code === 'FORBIDDEN' ? new ConnectorUnauthorizedError(body.errors[0].message, 403) : new Error(body.errors[0].message);
  const surcharges: { id: string; sku: string; priceWithTax: number }[] = body.data.order?.surcharges ?? [];
  return surcharges.filter(item => item.sku === TALLY_DISCOUNT_SKU).map(({ id, priceWithTax }) => ({ id, priceWithTax }));
}

/** Each line's total for a refund, after its till discount where the plugin's lineTotalsForRefund (#460) places one. */
export function refundLineTotals(order: TillOrder, quantities: RefundDraft['quantities']): Record<string, number> {
  const lines = vendureRefundable(order).lines;
  const totals = Object.fromEntries(lines.map(line => [line.orderLineId, line.lineTotalWithTax]));
  const discounts = order.tallyDiscounts ?? [];
  if (!discounts.length) return totals;
  let links: unknown;
  try { links = JSON.parse(order.customFields?.tallySnapshot ?? '').lineDiscounts; } catch { /* unparsable: unlinked */ }
  if (typeof links === 'object' && links !== null && !Array.isArray(links)) {
    const linked = Object.entries(links).map(([lineId, id]) => [lineId, discounts.find(item => item.id === String(id))] as const);
    // A missing or unlinked discount: the plugin refuses (discount_unlinked), so undiscounted, and the till shows that answer.
    if (linked.some(([, discount]) => !discount) || discounts.some(discount => !linked.some(([, item]) => item === discount))) return totals;
    for (const [lineId, discount] of linked) if (Object.hasOwn(totals, lineId)) totals[lineId] += discount!.priceWithTax;
    return totals;
  }
  const sum = discounts.reduce((total, discount) => total + discount.priceWithTax, 0);
  // Unlinked: the one line, or everything left with no earlier refund by line on the highest refunded line id; else undiscounted.
  const whole = lines.every(line => line.refundedQuantity === 0 && (quantities[line.orderLineId] ?? 0) === line.refundableQuantity);
  const last = lines.length === 1 ? lines[0].orderLineId : !whole ? undefined : lines.map(line => line.orderLineId)
    .filter(id => (quantities[id] ?? 0) > 0).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  return last === undefined ? totals : { ...totals, [last]: totals[last] + sum };
}

/** Sum of vendureLineRefundWithTax over the lines with a quantity above 0; quantities are by order line id. */
export function refundTotalMinor(order: TillOrder, quantities: RefundDraft['quantities']): number {
  const totals = refundLineTotals(order, quantities);
  let total = 0;
  for (const line of vendureRefundable(order).lines) {
    const quantity = quantities[line.orderLineId] ?? 0;
    // The plugin's own line-share rule, so partial refunds add up to the line and never trip amount_mismatch.
    if (quantity > 0) total += vendureLineRefundWithTax({ ...line, lineTotalWithTax: totals[line.orderLineId] }, quantity);
  }
  // The plugin's roundingForRefund adds the bridge and the cash rounding only when this refund takes everything left on the lines.
  if (Object.values(quantities).some(quantity => quantity > 0)
    && vendureRefundable(order).lines.every(line => (quantities[line.orderLineId] ?? 0) === line.refundableQuantity))
    total += order.surcharges.filter(surcharge => surcharge.sku === TALLY_ROUNDING_SKU || surcharge.sku === TALLY_CASH_ROUNDING_SKU)
      .reduce((sum, surcharge) => sum + surcharge.priceWithTax, 0);
  return total;
}

/** The order.refund v1 envelope for the cashier's quantities. The plugin is authoritative, so nothing else is checked here. */
export function buildRefundEnvelope(order: TillOrder, draft: RefundDraft, till: RefundTill,
  ids?: { id?: string; clientRefundId?: string; now?: string }): OrderRefundEnvelope {
  const id = ids?.id ?? mintUuid();
  const clientRefundId = ids?.clientRefundId ?? mintUuid();
  const now = ids?.now ?? new Date().toISOString();
  const clientOrderId = order.customFields?.tallyClientOrderId;
  const payload: OrderRefundPayload = {
    clientRefundId, orderId: order.id,
    // Left out, never undefined or null, for an order without one: the plugin checks it against the order's when sent.
    ...(clientOrderId ? { clientOrderId } : {}),
    lines: order.lines
      .filter((line) => (draft.quantities[line.id] ?? 0) > 0)
      .map((line) => ({ orderLineId: line.id, quantity: draft.quantities[line.id], restock: draft.restock })),
    shippingMinor: 0, adjustmentMinor: 0,
    totalMinor: refundTotalMinor(order, draft.quantities),
    destination: 'original_method',
    reason: draft.reason.trim(),
    registerId: till.registerId, sessionId: till.sessionId, cashierRef: till.cashierRef,
    createdAt: now,
  };
  return { id, type: 'order.refund', version: 1, payload, createdAt: now, deviceId: till.deviceId, attempt: 1 };
}

/** The order's refund still waiting for an answer, if any: the form offers only "Send again" for it. */
export async function pendingRefund(refunds: PosRefundCollection, orderId: string): Promise<PosRefund | null> {
  const doc = await refunds.findOne({ selector: { orderId, status: 'pending' } }).exec();
  // The same data as toJSON(), typed as the PosRefund submitOrderRefund returns rather than deep-readonly.
  return doc ? doc.toMutableJSON() : null;
}

export type RefundAttempt =
  | { kind: 'answered'; outcome: OrderRefundOutcome; record: PosRefund }
  | { kind: 'pending'; record: PosRefund }
  // #525: the till's own refusal; nothing stored, nothing sent.
  | { kind: 'not_sent'; code: 'rounding_exceeds_rest' };
/** submitOrderRefund, with RefundAnswerPendingError as { kind: 'pending' }; any other error is rethrown. */
export async function sendTillRefund(refunds: PosRefundCollection, transport: CommandTransport<OrderRefundEnvelope>,
  envelope: OrderRefundEnvelope): Promise<RefundAttempt> {
  // #525, desk ruling 2026-11-26: a total below 0 is the order's negative rounding taking more than the lines left
  // (shipping still on the order). The till never sends it; the plugin's invalid_payload stays the backstop.
  if (envelope.payload.totalMinor < 0) return { kind: 'not_sent', code: 'rounding_exceeds_rest' };
  try {
    const { outcome, record } = await submitOrderRefund({ refunds, transport, envelope });
    return { kind: 'answered', outcome, record };
  } catch (error) {
    if (error instanceof RefundAnswerPendingError) return { kind: 'pending', record: error.record };
    throw error;
  }
}

export type RefundMessage = { text: string; sendAgain: boolean; signInAgain: boolean; done: boolean };

/** The lead line of a record TallyUI parked needs_admin (still pending, error.code needs_admin); null for any other record. */
function parkedNeedsAdminLine(record: PosRefund): string | null {
  if (record.status !== 'pending' || record.error?.code !== 'needs_admin') return null;
  const reason = record.error.data?.reason;
  return refundNeedsAdminLine(typeof reason === 'string' ? reason : '');
}

/** The cashier's words for a refund attempt, with what the form offers next. */
export function refundMessage(attempt: RefundAttempt, currency: string): RefundMessage {
  const message = (text: string, flags: Partial<Omit<RefundMessage, 'text'>> = {}): RefundMessage =>
    ({ text, sendAgain: false, signInAgain: false, done: false, ...flags });
  if (attempt.kind === 'not_sent') return message(REFUND_ROUNDING_EXCEEDS_TEXT);
  const parked = parkedNeedsAdminLine(attempt.record);
  if (attempt.kind === 'pending') return message(parked ?? REFUND_PENDING_TEXT, { sendAgain: true });
  const { outcome } = attempt;
  switch (outcome.kind) {
    case 'applied':
      return message(`Refunded ${formatMoney({ amount: outcome.refund.totalMinor, currency }) ?? ''} to the original payment.`, { done: true });
    case 'rejected': {
      const { error } = outcome;
      switch (error.code) {
        case 'nothing_to_refund': return message(REFUND_NOTHING_TEXT);
        case 'quantity_exceeds': return message(REFUND_QUANTITY_EXCEEDS_TEXT);
        case 'amount_mismatch': return message(REFUND_AMOUNT_MISMATCH_TEXT);
        case 'order_state': return message(`The store can't refund an order that is ${orderStateLabel(String(error.data?.state ?? ''))}.`);
        case 'not_till_order': return message(REFUND_NOT_TILL_ORDER_TEXT);
        case 'forbidden': return message(REFUND_FORBIDDEN_TEXT);
        case 'no_open_session': return message(REFUND_NO_SESSION_TEXT);
        case 'discount_unlinked': return message(REFUND_DISCOUNT_UNLINKED_TEXT);
        case 'rounding_exceeds_rest': return message(REFUND_ROUNDING_EXCEEDS_TEXT);
        default: return message(`The store refused this refund (${error.code}). Nothing was refunded.`);
      }
    }
    case 'needs_admin':
      return message(refundNeedsAdminLine(outcome.reason), { sendAgain: true });
    case 'unknown':
      return message(parked ?? REFUND_UNKNOWN_TEXT, { sendAgain: true });
    case 'refused':
      if (parked) return message(parked, { sendAgain: true });
      // Still pending: the store may hold an earlier send of this envelope, so "Nothing was refunded" is not known.
      if (attempt.record.status === 'pending') return message(REFUND_UNKNOWN_TEXT, { sendAgain: true });
      return message(`The store refused the request (${outcome.status}). Nothing was refunded. Send it again or try later.`, { sendAgain: true });
    case 'unauthorized':
      return message(REFUND_UNAUTHORIZED_TEXT, { sendAgain: true, signInAgain: true });
  }
}
