import { describe, expect, it } from 'vitest';
import { SHOP_CANCEL_REASON, SHOP_REFUND_REASON, isPosOrder, shopHistoryData, shopRefundReason } from '../src/api/shop-api';

describe('Shop staff text', () => {
  const pos = { posOrder: true, tillRefund: false };
  const till = { posOrder: false, tillRefund: true };
  const storefront = { posOrder: false, tillRefund: false };

  it('U1: replaces a POS refund reason', () => {
    expect(shopRefundReason('p-text', pos)).toBe(SHOP_REFUND_REASON);
  });
  it('U2: replaces a till refund reason', () => {
    expect(shopRefundReason('p-text', till)).toBe(SHOP_REFUND_REASON);
  });
  it('U3: preserves a storefront refund reason', () => {
    expect(shopRefundReason('p-text', storefront)).toBe('p-text');
  });
  it('U4: preserves absent and empty refund reasons', () => {
    for (const reason of [null, '', undefined]) expect(shopRefundReason(reason, pos)).toBe(reason);
  });
  it('U5: replaces a cancellation reason without mutating the entry', () => {
    const data = { reason: 'x', lines: [] };
    expect(shopHistoryData('ORDER_CANCELLATION', data, pos)).toEqual({ reason: SHOP_CANCEL_REASON, lines: [] });
    expect(data).toEqual({ reason: 'x', lines: [] });
  });
  it('U6: replaces only the reason in a till refund transition', () => {
    const data = { refundId: '1', reason: 'x', from: 'Pending', to: 'Settled' };
    expect(shopHistoryData('ORDER_REFUND_TRANSITION', data, till)).toEqual({ ...data, reason: SHOP_REFUND_REASON });
  });
  it('U7: drops every customer identity and the note from a customer change', () => {
    const data = { previousCustomerId: '1', previousCustomerName: 'A A', newCustomerId: '2', newCustomerName: 'B B', note: 'x' };
    expect(shopHistoryData('ORDER_CUSTOMER_UPDATED', data, pos)).toEqual({});
    expect(shopHistoryData('ORDER_CUSTOMER_UPDATED', data, till)).toEqual({});
  });
  it('preserves an already empty POS customer change by reference', () => {
    const data = {};
    expect(shopHistoryData('ORDER_CUSTOMER_UPDATED', data, pos)).toBe(data);
  });
  it('U8: preserves all three storefront history entries', () => {
    const data = { reason: 'x', note: 'x' };
    for (const type of ['ORDER_CANCELLATION', 'ORDER_REFUND_TRANSITION', 'ORDER_CUSTOMER_UPDATED']) {
      expect(shopHistoryData(type, data, storefront)).toBe(data);
    }
  });
  it('U9: preserves other history types on POS orders', () => {
    const note = { note: 'x' };
    const transition = { from: 'a', to: 'b' };
    expect(shopHistoryData('ORDER_NOTE', note, pos)).toBe(note);
    expect(shopHistoryData('ORDER_STATE_TRANSITION', transition, pos)).toBe(transition);
  });
  it('U10: preserves cancellation data without a reason', () => {
    const data = { lines: [] };
    expect(shopHistoryData('ORDER_CANCELLATION', data, pos)).toBe(data);
  });
  it.each([
    [undefined, true], [null, true], [{}, false],
    [{ tallySnapshot: null, tallyClientOrderId: null, tallyRejected: false }, false],
    [{ tallySnapshot: '{}' }, true], [{ tallyClientOrderId: 'c' }, true],
    [{ tallyRejectedClientOrderId: 'c' }, true], [{ tallyRejected: true }, true],
  ] as const)('classifies custom fields %j as POS: %s', (customFields, expected) => {
    expect(isPosOrder(customFields)).toBe(expected);
  });
});
