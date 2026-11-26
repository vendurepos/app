import type { VendureOrder } from '@tallyui/connector-vendure';
import { ConnectorUnauthorizedError, formatMoney, type OrderRefundEnvelope, type SyncContext } from '@tallyui/core';
import { refundPayloadErrors } from '@tallyui/core/server';
import {
  mintUuid, posRefundCollection, refundNeedsAdminLine, type CommandTransport, type OrderRefundOutcome, type PosRefund, type PosRefundCollection,
  type TransportOutcome,
} from '@tallyui/pos';
import { createRxDatabase, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRefundEnvelope, fetchTillDiscounts, pendingRefund, refundLineTotals, refundMessage, refundTotalMinor, sendTillRefund,
  REFUND_AMOUNT_MISMATCH_TEXT, REFUND_DISCOUNT_UNLINKED_TEXT,
  REFUND_FORBIDDEN_TEXT, REFUND_NO_SESSION_TEXT, REFUND_NOT_TILL_ORDER_TEXT, REFUND_NOTHING_TEXT, REFUND_PENDING_TEXT,
  REFUND_QUANTITY_EXCEEDS_TEXT, REFUND_ROUNDING_EXCEEDS_TEXT, REFUND_UNAUTHORIZED_TEXT, REFUND_UNKNOWN_TEXT, TALLY_CASH_ROUNDING_SKU, type RefundAttempt, type RefundDiscount, type RefundTill,
  type TillOrder,
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
    id, quantity, orderPlacedQuantity: quantity, proratedUnitPrice: unit, proratedUnitPriceWithTax: unit,
    proratedLinePrice: proratedLinePriceWithTax, proratedLinePriceWithTax,
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

/** As order(), with these lines, the till's TALLY-DISCOUNT surcharges as fetchTillDiscounts reads them, and tallySnapshot. */
function discounted(lines: Line[], tallyDiscounts: RefundDiscount[], tallySnapshot: string | null,
  refunds: NonNullable<VendureOrder['payments']>[number]['refunds'] = []): TillOrder {
  return {
    ...order(refunds, { tallyClientOrderId: 'client-1', tallySnapshot }), lines, tallyDiscounts,
    surcharges: tallyDiscounts.map(({ priceWithTax }) => ({ description: 'POS discount', sku: 'TALLY-DISCOUNT', price: priceWithTax, priceWithTax })),
  };
}
const refundOf = (orderLineId: string, quantity: number) => ({
  id: `rf-${orderLineId}`, total: 0, items: 0, shipping: 0, adjustment: 0, state: 'Settled', reason: 'Damaged', metadata: {},
  lines: [{ orderLineId, quantity }],
});
const S1 = [{ id: 'S1', priceWithTax: -250 }];
const LINKED = JSON.stringify({ lineDiscounts: { L1: 'S1' } });
// Sold before #460's links: the snapshot has no lineDiscounts key.
const LEGACY = JSON.stringify({ display: {} });

it("prices a refund of a till-discounted line on the line after its linked discount, as the plugin does (BUG 3)", () => {
  // 2 × 10.00 with 2.50 off the line: 1750 for the line, 875 a unit.
  expect(refundTotalMinor(discounted([line('L1', 2, 2000)], S1, LINKED), { L1: 1 })).toBe(875);
  expect(refundTotalMinor(discounted([line('L1', 2, 2000)], S1, LINKED), { L1: 2 })).toBe(1750);
  // 1904 - 119 = 1785 for the line: round(892.5) = 893 for the first mug, 1785 - 893 = 892 for the second.
  expect(refundTotalMinor(discounted([line('L1', 2, 1904)], [{ id: 'S1', priceWithTax: -119 }], LINKED), { L1: 1 })).toBe(893);
  expect(refundTotalMinor(discounted([line('L1', 2, 1904)], [{ id: 'S1', priceWithTax: -119 }], LINKED, [refundOf('L1', 1)]), { L1: 1 })).toBe(892);
  // Only the linked line carries the discount.
  expect(refundTotalMinor(discounted([line('L1', 2, 2000), line('L2', 1, 500)], S1, LINKED), { L1: 1, L2: 1 })).toBe(1375);
  // A link to a surcharge the order does not have: undiscounted, and the plugin answers discount_unlinked.
  expect(refundTotalMinor(discounted([line('L1', 2, 2000)], S1, JSON.stringify({ lineDiscounts: { L1: 'S9' } })), { L1: 1 })).toBe(1000);
  // No discount surcharges read: the snapshot's links are not applied, so the figure is today's.
  expect(refundTotalMinor({ ...order([], { tallySnapshot: JSON.stringify({ lineDiscounts: { L2: 'S1' } }) }) }, { L2: 1 })).toBe(333);
});

it('a linked order with a discount no link names prices undiscounted, so the plugin refuses it', () => {
  const sale = discounted(order().lines, [{ id: 'S1', priceWithTax: -119 }, { id: 'S2', priceWithTax: -50 }], LINKED);
  expect(refundLineTotals(sale, { L1: 2, L2: 3 })).toEqual({ L1: 1904, L2: 1000 });
});

it('the refund that takes everything left on the lines takes the rounding bridge too, whatever its sign', () => {
  const surcharges = [{ description: 'POS rounding', sku: 'TALLY-ROUNDING', price: -2, priceWithTax: -2 }];
  const sale = { ...order(), surcharges };
  expect(refundTotalMinor(sale, { L1: 2, L2: 3 })).toBe(2902);
  expect(refundTotalMinor(sale, { L1: 1, L2: 0 })).toBe(952);
  expect(refundTotalMinor({ ...order([refundOf('L1', 1)]), surcharges }, { L1: 1, L2: 3 })).toBe(1950);
  expect(refundTotalMinor({ ...sale, surcharges: [{ ...surcharges[0], priceWithTax: 3 }] }, { L1: 2, L2: 3 })).toBe(2907);
});

describe("the cash rounding goes with the refund that takes everything left on the lines (the plugin's roundingForRefund)", () => {
  const cashRounding = { description: 'Cash rounding', sku: TALLY_CASH_ROUNDING_SKU, price: -2, priceWithTax: -2 };
  const bridge = { description: 'POS rounding', sku: 'TALLY-ROUNDING', price: -1, priceWithTax: -1 };

  it('R1: the refund of all lines of a cash-rounded order is the line totals − 2', () => {
    expect(TALLY_CASH_ROUNDING_SKU).toBe('TALLY-CASH-ROUNDING');
    expect(refundTotalMinor({ ...order(), surcharges: [cashRounding] }, { L1: 2, L2: 3 })).toBe(2904 - 2);
  });

  it('R2: a partial refund of the same order is the line totals, without the −2', () => {
    expect(refundTotalMinor({ ...order(), surcharges: [cashRounding] }, { L1: 1, L2: 0 })).toBe(952);
  });

  it("R3: after R2's refund, the refund of everything left includes the −2", () => {
    expect(refundTotalMinor({ ...order([refundOf('L1', 1)]), surcharges: [cashRounding] }, { L1: 1, L2: 3 })).toBe(952 + 1000 - 2);
  });

  it('R4: an order with the bridge −1 and the cash rounding −2 refunds −3 with everything left', () => {
    expect(refundTotalMinor({ ...order(), surcharges: [bridge, cashRounding] }, { L1: 2, L2: 3 })).toBe(2904 - 3);
  });

  it('R5: an order with neither refunds the line totals, as before (also pinned by "sums each line\'s share …")', () => {
    expect(refundTotalMinor(order(), { L1: 2, L2: 3 })).toBe(2904);
  });
});

it('an empty refund of a bridged order sends nothing, not the bridge', () => {
  const sale = {
    ...order(order().lines.map(line => refundOf(line.id, line.quantity))),
    surcharges: [{ description: 'POS rounding', sku: 'TALLY-ROUNDING', price: -2, priceWithTax: -2 }],
  };
  expect(refundTotalMinor(sale, {})).toBe(0);
  expect(refundTotalMinor(sale, { L1: 0, L2: 0 })).toBe(0);
});

it('places an unlinked (legacy) discount as the plugin does: the one line, or everything left on the highest line id', () => {
  expect(refundTotalMinor(discounted([line('L1', 2, 2000)], S1, LEGACY), { L1: 2 })).toBe(1750);
  expect(refundTotalMinor(discounted([line('L1', 2, 2000)], S1, null), { L1: 1 })).toBe(875);
  const two = discounted([line('L1', 2, 2000), line('L2', 1, 500)], S1, LEGACY);
  expect(refundTotalMinor(two, { L1: 2, L2: 1 })).toBe(2250);
  expect(refundLineTotals(two, { L1: 2, L2: 1 })).toEqual({ L1: 2000, L2: 250 });
  // Numeric-aware, as the plugin's localeCompare(..., { numeric: true }): 10 is after 9.
  expect(refundLineTotals(discounted([line('9', 1, 2000), line('10', 1, 500)], S1, LEGACY), { 9: 1, 10: 1 })).toEqual({ 9: 2000, 10: 250 });
  // A part of the order, or anything after an earlier refund by line: undiscounted, and the plugin answers discount_unlinked.
  expect(refundTotalMinor(two, { L1: 1 })).toBe(1000);
  expect(refundTotalMinor(discounted([line('L1', 2, 2000), line('L2', 1, 500)], S1, LEGACY, [refundOf('L1', 1)]), { L1: 1, L2: 1 }))
    .toBe(1500);
});

describe('fetchTillDiscounts', () => {
  const context: SyncContext = {
    connectorId: 'vendure', baseUrl: 'https://shop.example.com',
    headers: { Authorization: 'Bearer test-token', 'vendure-token': 'channel-1' }, signal: new AbortController().signal,
  };
  afterEach(() => vi.unstubAllGlobals());

  it("reads the order's TALLY-DISCOUNT surcharges with their ids, and nothing else", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: { order: { surcharges: [
      { id: '7', sku: 'TALLY-DISCOUNT', priceWithTax: -250 }, { id: '8', sku: 'TALLY-FEE', priceWithTax: 300 },
    ] } } }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchTillDiscounts(context, 'order-1')).toEqual([{ id: '7', priceWithTax: -250 }]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${context.baseUrl}/admin-api`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal });
    expect(JSON.parse(init.body).variables).toEqual({ id: 'order-1' });
  });

  it('throws for a 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 403 })));
    const request = fetchTillDiscounts(context, 'order-1');
    await expect(request).rejects.toThrow('Vendure API error: 403');
    await expect(request).rejects.toBeInstanceOf(ConnectorUnauthorizedError);
    await expect(request).rejects.toMatchObject({ status: 403 });
  });

  it('throws for a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
    const request = fetchTillDiscounts(context, 'order-1');
    await expect(request).rejects.toBeInstanceOf(ConnectorUnauthorizedError);
    await expect(request).rejects.toMatchObject({ status: 401 });
  });

  it('throws for a GraphQL FORBIDDEN with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ errors: [
      { message: 'You are not currently authorized to perform this action', extensions: { code: 'FORBIDDEN' } },
    ] })));
    const request = fetchTillDiscounts(context, 'order-1');
    await expect(request).rejects.toBeInstanceOf(ConnectorUnauthorizedError);
    await expect(request).rejects.toMatchObject({ status: 403 });
  });

  it('throws an ordinary error for other GraphQL errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ errors: [{ message: 'boom' }] })));
    const request = fetchTillDiscounts(context, 'order-1');
    await expect(request).rejects.toThrow('boom');
    await expect(request).rejects.not.toBeInstanceOf(ConnectorUnauthorizedError);
  });

  it('resolves to an empty array for a null order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { order: null } })));
    await expect(fetchTillDiscounts(context, 'order-1')).resolves.toEqual([]);
  });
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
  expect(rejected('discount_unlinked')).toEqual(words(REFUND_DISCOUNT_UNLINKED_TEXT));
  expect(rejected('rounding_exceeds_rest')).toEqual(words(REFUND_ROUNDING_EXCEEDS_TEXT));
  expect(REFUND_ROUNDING_EXCEEDS_TEXT).toBe("This order's rounding is more than what is left to refund on it, so the rest can't be refunded at the till. Refund the rest in Vendure admin, by amount.");
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

describe('a refund an admin must finish (needs_admin)', () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const base: PosRefund = {
    id: 'refund-1', commandId: 'command-1', orderId: 'order-1', sessionId: 's1', registerId: 'r1', envelope,
    status: 'pending', createdAt: NOW, updatedAt: NOW,
  };
  const parked = (reason: unknown): PosRefund =>
    ({ ...base, error: { code: 'needs_admin', message: 'Ask a manager', data: { reason, at: NOW } } });
  const words = (text: string) => ({ text, sendAgain: true, signInAgain: false, done: false });
  const say = (outcome: OrderRefundOutcome, record: PosRefund) => refundMessage({ kind: 'answered', outcome, record }, 'EUR');

  it("says TallyUI's needs_admin line for the store's first answer, whatever the record says", () => {
    const outcome: OrderRefundOutcome = { kind: 'needs_admin', reason: 'session_closed', message: 'Ask a manager' };
    expect(say(outcome, base)).toEqual(words(refundNeedsAdminLine('session_closed')));
    expect(say(outcome, { ...base, status: 'rejected' })).toEqual(words(refundNeedsAdminLine('session_closed')));
    expect(say({ ...outcome, reason: 'payment_failed' }, parked('session_closed'))).toEqual(words(refundNeedsAdminLine('payment_failed')));
  });

  it('says the line again when the form reopens on the parked record, by its stored reason', () => {
    expect(refundMessage({ kind: 'pending', record: parked('session_closed') }, 'EUR')).toEqual(words(refundNeedsAdminLine('session_closed')));
    expect(refundMessage({ kind: 'pending', record: parked('payment_failed') }, 'EUR')).toEqual(words(refundNeedsAdminLine('payment_failed')));
    expect(refundMessage({ kind: 'pending', record: parked(7) }, 'EUR')).toEqual(words(refundNeedsAdminLine('')));
    expect(refundMessage({ kind: 'pending', record: { ...parked('session_closed'), status: 'unsent' } }, 'EUR')).toEqual(words(REFUND_PENDING_TEXT));
  });

  it('keeps the line when a resend of the parked record is unknown or refused', () => {
    const line = words(refundNeedsAdminLine('session_closed'));
    expect(say({ kind: 'unknown', reason: 'network' }, parked('session_closed'))).toEqual(line);
    expect(say({ kind: 'refused', status: 503, reason: 'status_503' }, parked('session_closed'))).toEqual(line);
  });

  it('never says nothing was refunded while the record is still pending', () => {
    const refused: OrderRefundOutcome = { kind: 'refused', status: 503, reason: 'status_503' };
    expect(say(refused, base)).toEqual(words(REFUND_UNKNOWN_TEXT));
    expect(say(refused, { ...base, status: 'unsent', error: { code: 'refused', message: 'status_503', data: { status: 503 } } }))
      .toEqual(words('The store refused the request (503). Nothing was refunded. Send it again or try later.'));
  });
});

it('a refused resend after an unknown answer stays pending and says the answer is unknown', async () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const fake = transport({ kind: 'retry', reason: 'timeout' }, { kind: 'refused', status: 503, reason: 'status_503' });
  const first = await sendTillRefund(refunds, fake, envelope);
  expect(refundMessage(first, 'EUR').text).toBe(REFUND_UNKNOWN_TEXT);
  const again = await sendTillRefund(refunds, fake, envelope);
  expect(again.kind === 'answered' && again.outcome.kind).toBe('refused');
  expect(again.record.status).toBe('pending');
  expect(refundMessage(again, 'EUR')).toEqual({ text: REFUND_UNKNOWN_TEXT, sendAgain: true, signInAgain: false, done: false });
});

it("parks a refund the store answers needs_admin, and the reopened form says the same line", async () => {
  const envelope = buildRefundEnvelope(order(), draft, till, ids);
  const fake = transport({
    kind: 'retry', reason: 'needs_admin:session_closed',
    needsAdmin: { id: envelope.id, reason: 'session_closed', message: 'The session closed before the refund finished.' },
  });
  const attempt = await sendTillRefund(refunds, fake, envelope);
  expect(attempt.kind === 'answered' && attempt.outcome.kind).toBe('needs_admin');
  const line = { text: refundNeedsAdminLine('session_closed'), sendAgain: true, signInAgain: false, done: false };
  expect(refundMessage(attempt, 'EUR')).toEqual(line);
  const record = await pendingRefund(refunds, 'order-1');
  expect(record).toMatchObject({ id: 'refund-1', status: 'pending', error: { code: 'needs_admin', data: { reason: 'session_closed' } } });
  expect(refundMessage({ kind: 'pending', record: record! }, 'EUR')).toEqual(line);
});
