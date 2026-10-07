import { expect, it } from 'vitest';
import { ConnectorUnauthorizedError } from '@tallyui/core';
import type { VendureOrderSummary } from '@tallyui/connector-vendure';
import { ORDER_HISTORY_FAILED_TEXT, ORDER_HISTORY_FORBIDDEN_TEXT, orderHistoryNotice, orderStateLabel, toOrderHistoryRow } from './order-history';
import { SESSION_ENDED_TEXT } from './use-catalogue';

it('labels Vendure order states as words', () => {
  expect(orderStateLabel('PaymentSettled')).toBe('Payment settled');
  expect(orderStateLabel('ArrangingAdditionalPayment')).toBe('Arranging additional payment');
  expect(orderStateLabel('Cancelled')).toBe('Cancelled');
});

it('maps a POS sale and an admin order to history rows', () => {
  const customFields = {
    tallyClientOrderId: 'client-1', tallySaleAt: null, tallyRegisterId: null, tallySessionId: null,
    tallyCashierRef: null, tallyRejected: null, tallyRejectedClientOrderId: null,
  };
  const sale: VendureOrderSummary = {
    id: 'store-1', code: 'ABC123', state: 'PaymentSettled', orderPlacedAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-03T03:04:05.000Z', currencyCode: 'EUR', totalQuantity: 2, total: 1600,
    totalWithTax: 1904, customer: null, customFields,
  };
  expect(toOrderHistoryRow(sale)).toEqual({
    id: 'store-1', clientOrderId: 'client-1', reference: 'ABC123', placedAt: '2026-01-02T03:04:05.000Z',
    totalMinor: 1904, currency: 'EUR', itemCount: 2, stateLabel: 'Payment settled',
  });
  const admin: VendureOrderSummary = {
    ...sale, id: 'store-2', orderPlacedAt: null, customFields: { ...customFields, tallyClientOrderId: null },
  };
  const row = toOrderHistoryRow(admin);
  expect(row.placedAt).toBe(admin.updatedAt);
  expect('clientOrderId' in row).toBe(false);
});

it('reports missing Read order permission without a retry', () => {
  expect(orderHistoryNotice(new ConnectorUnauthorizedError('x', 403)))
    .toEqual({ text: ORDER_HISTORY_FORBIDDEN_TEXT, retry: false });
});

it('reports an ended session without a retry', () => {
  expect(orderHistoryNotice(new ConnectorUnauthorizedError('x', 401)))
    .toEqual({ text: SESSION_ENDED_TEXT, retry: false });
});

it('offers a retry for other history failures', () => {
  expect(orderHistoryNotice(new Error('boom'))).toEqual({ text: ORDER_HISTORY_FAILED_TEXT, retry: true });
});
