import { expect, it } from 'vitest';
import type { OrderHistoryRow } from '@tallyui/components';
import type { VendureOrder } from '@tallyui/connector-vendure';
import { ConnectorUnauthorizedError, formatMoney } from '@tallyui/core';
import type { PosOrder } from '@tallyui/pos';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import {
  ORDER_DETAIL_FAILED_TEXT, ORDER_NOT_SYNCED_TEXT, orderDetailNotice, orderDetailTarget, orderDetailView, toOrderStatus,
} from './order-detail';
import { ORDER_HISTORY_FORBIDDEN_TEXT } from './order-history';

const historyRow: OrderHistoryRow = {
  id: 'store-7', reference: 'ABC123', placedAt: '2026-01-02T03:04:05.000Z', totalMinor: 2856, currency: 'EUR',
  itemCount: 3, stateLabel: 'Payment settled',
};

// Only the fields orderDetailTarget reads; the rest of a PosOrder doesn't change which order opens.
const tillSale = (fields: Pick<PosOrder, 'syncStatus'> & Partial<Pick<PosOrder, 'serverRefs'>>) =>
  ({ id: 'client-1', ...fields }) as PosOrder;

const money = (amount: number) => formatMoney({ amount, currency: 'EUR' });

it('opens a store order by its Vendure id', () => {
  expect(orderDetailTarget(historyRow)).toEqual({ orderId: 'store-7' });
  expect(orderDetailTarget({ ...historyRow, clientOrderId: 'client-9' })).toEqual({ orderId: 'store-7' });
});

it('opens a synced till sale by its server order id', () => {
  const sale = tillSale({ syncStatus: 'applied', serverRefs: { orderId: 'T_42', displayId: 'XYZ', totalMinor: 2856 } });
  expect(orderDetailTarget(sale)).toEqual({ orderId: 'T_42' });
});

it('notes a pending or rejected till sale instead of opening it', () => {
  expect(orderDetailTarget(tillSale({ syncStatus: 'pending' }))).toEqual({ note: ORDER_NOT_SYNCED_TEXT });
  expect(orderDetailTarget(tillSale({ syncStatus: 'rejected' }))).toEqual({ note: ORDER_NOT_SYNCED_TEXT });
  // Only an applied sale opens, and only once it carries the store's order id.
  expect(orderDetailTarget(tillSale({ syncStatus: 'rejected', serverRefs: { orderId: 'T_1', totalMinor: 1 } })))
    .toEqual({ note: ORDER_NOT_SYNCED_TEXT });
  expect(orderDetailTarget(tillSale({ syncStatus: 'applied' }))).toEqual({ note: ORDER_NOT_SYNCED_TEXT });
});

it('maps Vendure order states to the detail badge', () => {
  expect(toOrderStatus('Cancelled')).toBe('cancelled');
  for (const state of ['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered']) {
    expect(toOrderStatus(state)).toBe('completed');
  }
  expect(toOrderStatus('ArrangingPayment')).toBe('pending');
  expect(toOrderStatus('PaymentAuthorized')).toBe('pending');
  for (const state of ['AddingItems', 'Draft', 'Modifying', 'ArrangingAdditionalPayment', 'SomeCustomState']) {
    expect(toOrderStatus(state)).toBe('processing');
  }
});

it("shows a Vendure order's lines, totals, payments and refunds as text", () => {
  const line = (id: string, name: string, proratedLinePriceWithTax: number, tallyCustomName: string | null) => ({
    id, quantity: id === 'line-1' ? 2 : 1, proratedLinePriceWithTax, productVariant: { id: `v-${id}`, name, sku: `SKU-${id}` },
    customFields: {
      tallyCustomName, tallyCustomSku: null, tallyUnitPrice: null, tallyPriceIncludesTax: null, tallyClientLineId: null,
    },
  });
  // Only the fields orderDetailView reads; the rest of VendureOrder is the store's and unused here.
  const order = {
    id: 'store-7', code: 'ABC123', state: 'PaymentSettled', currencyCode: 'EUR',
    total: 2400, totalWithTax: 2856, subTotalWithTax: 2856,
    lines: [line('line-1', 'Mug', 1904, null), line('line-2', 'Open item', 952, 'Gift wrap')],
    payments: [{
      id: 'pay-1', amount: 2856, state: 'Settled',
      refunds: [{ id: 'refund-1', total: 952, state: 'Settled' }],
    }],
  } as unknown as VendureOrder;
  expect(orderDetailView(order)).toEqual({
    orderNumber: 'ABC123',
    status: 'completed',
    lineItems: [
      { name: 'Mug', quantity: 2, total: money(1904) },
      { name: 'Gift wrap', quantity: 1, total: money(952) },
    ],
    subtotal: money(2856),
    tax: money(456),
    total: money(2856),
    payments: [{
      id: 'pay-1', text: `Paid ${money(2856)} · Settled`,
      refunds: [{ id: 'refund-1', text: `Refunded ${money(952)} · Settled` }],
    }],
  });
  expect(orderDetailView({ ...order, payments: undefined }).payments).toEqual([]);
});

it('says an order that is gone, a refused read and a failed read in words', () => {
  expect(orderDetailNotice(new ConnectorUnauthorizedError('x', 403)))
    .toEqual({ text: ORDER_HISTORY_FORBIDDEN_TEXT, retry: false });
  expect(orderDetailNotice(new ConnectorUnauthorizedError('x', 401))).toEqual({ text: SESSION_ENDED_TEXT, retry: false });
  expect(orderDetailNotice(new Error('boom'))).toEqual({ text: ORDER_DETAIL_FAILED_TEXT, retry: true });
});
