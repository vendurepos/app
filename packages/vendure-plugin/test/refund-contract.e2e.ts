import { Channel, Order, Payment, PaymentMethod, RequestContext } from '@vendure/core';
import { assert, beforeEach, expect, it } from 'vitest';
import {
  markTallyRoute, tallyPaymentHandler, tallyRefundMethod, TALLY_PAYMENT_METHOD_CODE, withTallyRefund,
} from '../src/config/strategies';
import type { TallyRefundContext } from '../src/config/strategies';
import { parseCommandResult } from '../src/vendored/command-result';
import { refundPayloadErrors } from '../src/vendored/refund-payload-shape';
import { deriveSessionFigures } from '../src/vendored/register-figures';

let ctx: RequestContext;
beforeEach(() => {
  ctx = new RequestContext({
    apiType: 'custom', isAuthorized: true, authorizedAsOwnerOnly: false, channel: new Channel({ id: 1 }),
  });
});
const refund: TallyRefundContext = {
  clientRefundId: 'r-1', registerId: 'reg-1', sessionId: 's-1', cashierRef: 'c-1', destination: 'original_method',
};
const payment = Object.assign(new Payment({ id: 'p-1' }), { metadata: { tender: { method: 'card', amountMinor: 500 } } });
const input = { paymentId: 'p-1', lines: [], shipping: 0, adjustment: 0, amount: 500, reason: 'Returned item' };
const order = new Order({ id: 'o-1' });
const method = new PaymentMethod({ code: TALLY_PAYMENT_METHOD_CODE });

it('createRefund settles a till refund with its metadata', async () => {
  withTallyRefund(markTallyRoute(ctx), refund);
  const expected = { state: 'Settled', metadata: {
    tallyClientRefundId: 'r-1', tallyRegisterId: 'reg-1', tallySessionId: 's-1', tallyCashierRef: 'c-1',
    tallyDestination: 'original_method', tallyMethod: 'card',
  } };
  expect(await tallyPaymentHandler.createRefund(ctx, input, 500, order, payment, [], method)).toEqual(expected);
  expect(await tallyPaymentHandler.createRefund(ctx.copy(), input, 500, order, payment, [], method)).toEqual(expected);
});

it('a cash refund leaves as cash, and no cashier key without a cashierRef', async () => {
  withTallyRefund(markTallyRoute(ctx), {
    clientRefundId: 'r-1', registerId: 'reg-1', sessionId: 's-1', destination: 'cash',
  });
  const result = await tallyPaymentHandler.createRefund(ctx, input, 500, order, payment, [], method);
  assert(result && result.metadata);
  expect(result.metadata.tallyMethod).toBe('cash');
  expect('tallyCashierRef' in result.metadata).toBe(false);
});

it('outside a till refund, createRefund settles without metadata', async () => {
  const refundOnly = withTallyRefund(ctx.copy(), refund);
  const routeOnly = markTallyRoute(ctx.copy());
  for (const context of [refundOnly, routeOnly, ctx]) {
    expect(await tallyPaymentHandler.createRefund(context, input, 500, order, payment, [], method))
      .toEqual({ state: 'Settled' });
  }
});

it('tallyRefundMethod falls back to the tally-pos code when the payment has no tender method', () => {
  for (const metadata of [undefined, {}, { tender: {} }, { tender: { method: '' } }, { tender: { method: 42 } }]) {
    expect(tallyRefundMethod('original_method', Object.assign(new Payment({}), { metadata }))).toBe(TALLY_PAYMENT_METHOD_CODE);
  }
});

it('the vendored refund shape accepts a valid v1 payload and names a bad one', () => {
  const payload = {
    ...refund, orderId: 'o-1', clientOrderId: 'co-1', lines: [{ orderLineId: 'ol-1', quantity: 1, restock: true }],
    shippingMinor: 0, adjustmentMinor: 0, totalMinor: 500, reason: 'Returned item', createdAt: '2026-10-07T10:00:00Z',
  };
  expect(refundPayloadErrors(payload)).toEqual([]);
  expect(refundPayloadErrors({ ...payload, extra: 1 })).toEqual(['extra: unknown field for order.refund version 1']);
  expect(refundPayloadErrors({ ...payload, lines: [...payload.lines, ...payload.lines] }))
    .toEqual(expect.arrayContaining([expect.stringContaining('unique in lines')]));
});

it('the vendored parser accepts an applied refund result and refuses one whose byMethod does not sum', () => {
  const result = { id: 'cmd-1', status: 'applied', refund: {
    totalMinor: 500, byMethod: { card: 500 },
    refunds: [{ id: 'refund-1', paymentId: 'p-1', totalMinor: 500, state: 'Settled' }],
  } };
  expect(parseCommandResult(result)).toEqual(result);
  expect(() => parseCommandResult({ ...result, refund: { ...result.refund, byMethod: { card: 499 } } }))
    .toThrow('Invalid refund.byMethod');
});

it('the vendored figures lower expected per method by the refunds', () => {
  expect(deriveSessionFigures({
    countedFloatMinor: 1000,
    orders: [{ payments: [{ method: 'cash', amountMinor: 500 }, { method: 'card', amountMinor: 700 }] }],
    movements: [], refunds: [{ byMethod: { cash: 200 } }, { byMethod: { card: 300 } }],
  })).toEqual({ expected: { cash: 1300, card: 400 }, salesCount: 1, refundsTotalMinor: 500 });
});
