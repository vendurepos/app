import type { VendureOrder } from '@tallyui/connector-vendure';
import { formatMoney, type OrderRefundEnvelope } from '@tallyui/core';
import { refundPayloadErrors } from '@tallyui/core/server';
import {
  mintUuid, posRefundCollection, type CommandTransport, type OrderRefundOutcome, type PosRefund, type PosRefundCollection,
  type TransportOutcome,
} from '@tallyui/pos';
import { createRxDatabase, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  buildRefundEnvelope, pendingRefund, refundMessage, refundTotalMinor, sendTillRefund, REFUND_AMOUNT_MISMATCH_TEXT,
  REFUND_FORBIDDEN_TEXT, REFUND_NO_SESSION_TEXT, REFUND_NOT_TILL_ORDER_TEXT, REFUND_NOTHING_TEXT, REFUND_PENDING_TEXT,
  REFUND_QUANTITY_EXCEEDS_TEXT, REFUND_UNAUTHORIZED_TEXT, REFUND_UNKNOWN_TEXT, type RefundAttempt, type RefundTill,
} from './till-refund';

const till: RefundTill = { sessionId: 's1', registerId: 'r1', deviceId: 'd1', cashierRef: 'sam' };
const NOW = '2026-11-10T09:00:00.000Z';
const ids = { id: 'command-1', clientRefundId: 'refund-1', now: NOW };
// The plugin's order.refund v1 fields (packages/vendure-plugin/src/vendored/refund-payload-shape.ts).
const PAYLOAD_FIELDS = ['clientRefundId', 'orderId', 'registerId', 'sessionId', 'clientOrderId', 'cashierRef',
  'lines', 'shippingMinor', 'totalMinor', 'adjustmentMinor', 'destination', 'reason', 'createdAt'];

type Line = VendureOrder['lines'][number];
/** A line whose per-unit refund value is rounded per unit, so unitRefundWithTax × quantity drifts from the line share. */
function line(id: string, quantity: number, proratedLinePriceWithTax: number): Line {
  const unit = Math.round(proratedLinePriceWithTax / quantity);
  return {
    id, quantity, orderPlacedQuantity: quantity, proratedUnitPrice: unit, proratedUnitPriceWithTax: unit, proratedLinePriceWithTax,
    taxRate: 19, productVariant: { id: `v-${id}`, name: `Item ${id}`, sku: `SKU-${id}` },
    unitPrice: unit, unitPriceWithTax: unit, linePrice: proratedLinePriceWithTax, linePriceWithTax: proratedLinePriceWithTax,
    discountedLinePrice: proratedLinePriceWithTax, discountedLinePriceWithTax: proratedLinePriceWithTax, discounts: [],
  };
}

/** L1: 2 for 19.04; L2: 3 for 10.00; one settled payment of 29.04, with the given refunds against it. */
function order(refunds: NonNullable<VendureOrder['payments']>[number]['refunds'] = [],
  customFields: Partial<NonNullable<VendureOrder['customFields']>> = { tallyClientOrderId: 'client-1' }): VendureOrder {
  return {
    id: 'order-1', code: 'ABC123', state: 'PaymentSettled', orderPlacedAt: NOW, updatedAt: NOW, currencyCode: 'EUR',
    totalQuantity: 5, total: 2440, totalWithTax: 2904, customer: null, active: false,
    lines: [line('L1', 2, 1904), line('L2', 3, 1000)],
    shippingLines: [], surcharges: [], subTotal: 2440, subTotalWithTax: 2904, shipping: 0, shippingWithTax: 0,
    taxSummary: [], discounts: [], couponCodes: [],
    payments: [{
      id: 'p1', method: 'cash', amount: 2904, state: 'Settled', transactionId: '', createdAt: NOW, metadata: {}, refunds,
    }],
    customFields: {
      tallyClientOrderId: null, tallySaleAt: null, tallyRegisterId: null, tallySessionId: null, tallyCashierRef: null,
      tallyRejected: null, tallyRejectedClientOrderId: null, tallyPayments: null, tallySnapshot: null, tallyShipping: null,
      ...customFields,
    },
  };
}

const draft = { quantities: { L1: 1, L2: 0 }, reason: '  Damaged ', restock: true };

let database: RxDatabase;
let refunds: PosRefundCollection;
beforeEach(async () => {
  database = await createRxDatabase({
    name: `refunds-${mintUuid()}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }),
  });
  ({ pos_refunds: refunds } = await database.addCollections({ pos_refunds: posRefundCollection() }));
});
afterEach(async () => {
  await database.close();
});

function transport(...answers: TransportOutcome[]) {
  const send = vi.fn<CommandTransport<OrderRefundEnvelope>['send']>();
  for (const answer of answers) send.mockResolvedValueOnce(answer);
  return { send };
}
// The store's refund of 9.52, as the plugin answers it: parseCommandResult refuses an empty refunds list (bad_result).
const storeRefund = { totalMinor: 952, byMethod: { cash: 952 }, refunds: [{ id: 'rf-1', paymentId: 'p1', totalMinor: 952, state: 'Settled' }] };
const applied = (id: string): TransportOutcome => ({ kind: 'results', results: [{ id, status: 'applied', refund: storeRefund }] });

it('builds an order.refund v1 envelope the plugin accepts', () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  expect(envelope).toEqual({
    id: 'command-1', type: 'order.refund', version: 1, createdAt: NOW, deviceId: 'd1', attempt: 1,
    payload: {
      clientRefundId: 'refund-1', orderId: 'order-1', clientOrderId: 'client-1',
      lines: [{ orderLineId: 'L1', quantity: 1, restock: true }],
      shippingMinor: 0, adjustmentMinor: 0, totalMinor: 952, destination: 'original_method', reason: 'Damaged',
      registerId: 'r1', sessionId: 's1', cashierRef: 'sam', createdAt: NOW,
    },
  });
  expect(Object.keys(envelope.payload).filter((key) => !PAYLOAD_FIELDS.includes(key))).toEqual([]);
  expect(refundPayloadErrors(envelope.payload)).toEqual([]);
});

it('leaves clientOrderId out for an order without one', () => {
  const { payload } = buildRefundEnvelope(order([], { tallyClientOrderId: null }), draft, till, ids);
  expect(Object.keys(payload)).not.toContain('clientOrderId');
  expect(refundPayloadErrors(payload)).toEqual([]);
});

it("sums each line's share of its total, so partial refunds add up to the line", () => {
  expect(refundTotalMinor(order(), { L2: 1 })).toBe(333);
  const refund = (id: string, quantity: number) => ({
    id, total: 0, items: 0, shipping: 0, adjustment: 0, state: 'Settled', reason: 'Damaged', metadata: {},
    lines: [{ orderLineId: 'L2', quantity }],
  });
  expect(refundTotalMinor(order([refund('rf1', 1)]), { L2: 1 })).toBe(334);
  expect(refundTotalMinor(order([refund('rf1', 1), refund('rf2', 1)]), { L2: 1 })).toBe(333);
  expect(refundTotalMinor(order(), { L1: 1, L2: 3 })).toBe(1952);
});

it('throws for a quantity above what is left to refund', () => {
  expect(() => buildRefundEnvelope(order(), { ...draft, quantities: { L1: 3 } }, till, ids)).toThrow(RangeError);
  const refunded = order([{
    id: 'rf1', total: 952, items: 952, shipping: 0, adjustment: 0, state: 'Settled', reason: 'Damaged', metadata: {},
    lines: [{ orderLineId: 'L1', quantity: 2 }],
  }]);
  expect(() => refundTotalMinor(refunded, { L1: 1 })).toThrow(RangeError);
});

it('records an applied refund that the register can count', async () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const fake = transport(applied(envelope.id));
  const attempt = await sendTillRefund(refunds, fake, envelope);
  expect(attempt.kind).toBe('answered');
  expect(attempt.kind === 'answered' && attempt.outcome.kind).toBe('applied');
  expect((await refunds.findOne('refund-1').exec())?.toJSON()).toMatchObject({
    status: 'applied', commandId: 'command-1', orderId: 'order-1', sessionId: 's1', result: { totalMinor: 952, byMethod: { cash: 952 } },
  });
  const message = refundMessage(attempt, 'EUR');
  expect(message.done).toBe(true);
  expect(message.text).toContain(formatMoney({ amount: 952, currency: 'EUR' }));
  expect(await pendingRefund(refunds, 'order-1')).toBeNull();
});

it('keeps an unanswered refund pending and sends the same envelope again', async () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const fake = transport({ kind: 'retry', reason: 'network' }, applied(envelope.id));
  const first = await sendTillRefund(refunds, fake, envelope);
  expect(first.kind === 'answered' && first.outcome.kind).toBe('unknown');
  expect(await pendingRefund(refunds, 'order-1')).toMatchObject({ id: 'refund-1', commandId: 'command-1', status: 'pending' });
  expect(await pendingRefund(refunds, 'order-2')).toBeNull();
  const again = await sendTillRefund(refunds, fake, envelope);
  expect(fake.send.mock.calls[1][0][0].id).toBe('command-1');
  expect(again.kind === 'answered' && again.outcome.kind).toBe('applied');
  expect(again.record.status).toBe('applied');
});

it('answers a new attempt while one is pending with the pending record', async () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const fake = transport({ kind: 'retry', reason: 'timeout' });
  await sendTillRefund(refunds, fake, envelope);
  const attempt = await sendTillRefund(refunds, fake, { ...envelope, id: 'command-2' });
  expect(attempt).toMatchObject({ kind: 'pending', record: { id: 'refund-1', commandId: 'command-1', status: 'pending' } });
  expect(fake.send).toHaveBeenCalledTimes(1);
  expect(refundMessage(attempt, 'EUR')).toEqual({ text: REFUND_PENDING_TEXT, sendAgain: true, signInAgain: false, done: false });
});

it('says every rejection code and outcome in words', () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const record: PosRefund = {
    id: 'refund-1', commandId: 'command-1', orderId: 'order-1', sessionId: 's1', registerId: 'r1', envelope,
    status: 'rejected', createdAt: NOW, updatedAt: NOW,
  };
  const say = (outcome: OrderRefundOutcome) => refundMessage({ kind: 'answered', outcome, record } satisfies RefundAttempt, 'EUR');
  const rejected = (code: string, data?: Record<string, unknown>) => say({ kind: 'rejected', error: { code, message: code, data } });
  const words = (text: string, flags: { sendAgain?: boolean; signInAgain?: boolean; done?: boolean } = {}) =>
    ({ text, sendAgain: false, signInAgain: false, done: false, ...flags });
  const refunded = `Refunded ${formatMoney({ amount: 952, currency: 'EUR' })} to the original payment.`;
  expect(say({ kind: 'applied', refund: storeRefund, duplicate: false })).toEqual(words(refunded, { done: true }));
  expect(say({ kind: 'applied', refund: storeRefund, duplicate: true })).toEqual(words(refunded, { done: true }));
  expect(rejected('nothing_to_refund')).toEqual(words(REFUND_NOTHING_TEXT));
  expect(rejected('quantity_exceeds')).toEqual(words(REFUND_QUANTITY_EXCEEDS_TEXT));
  expect(rejected('amount_mismatch')).toEqual(words(REFUND_AMOUNT_MISMATCH_TEXT));
  expect(rejected('order_state', { state: 'PaymentAuthorized' }))
    .toEqual(words("The store can't refund an order that is Payment authorized."));
  expect(rejected('not_till_order')).toEqual(words(REFUND_NOT_TILL_ORDER_TEXT));
  expect(rejected('forbidden')).toEqual(words(REFUND_FORBIDDEN_TEXT));
  expect(rejected('no_open_session')).toEqual(words(REFUND_NO_SESSION_TEXT));
  expect(rejected('invalid_payload')).toEqual(words('The store refused this refund (invalid_payload). Nothing was refunded.'));
  expect(say({ kind: 'unknown', reason: 'network' })).toEqual(words(REFUND_UNKNOWN_TEXT, { sendAgain: true }));
  expect(say({ kind: 'refused', status: 503, reason: 'status_503' }))
    .toEqual(words('The store refused the request (503). Nothing was refunded. Send it again or try later.', { sendAgain: true }));
  expect(say({ kind: 'unauthorized' })).toEqual(words(REFUND_UNAUTHORIZED_TEXT, { sendAgain: true, signInAgain: true }));
  expect(refundMessage({ kind: 'pending', record: { ...record, status: 'pending' } }, 'EUR'))
    .toEqual(words(REFUND_PENDING_TEXT, { sendAgain: true }));
});
