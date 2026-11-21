import { expect, it } from 'vitest';
import type { VendureOrder } from '@tallyui/connector-vendure';
import { groupOrdersByDay, orderListOptions, ORDER_STATUS_OPTIONS, toOrderTableRow, VENDURE_ORDER_FILTER_FIELDS } from './order-list';
import { toOrderHistoryRow } from './order-history';

const order: VendureOrder = {
  id: '2', code: 'AB12', state: 'PaymentSettled', active: false, orderPlacedAt: '2026-11-17T03:00:00.000Z',
  updatedAt: '2026-11-18T03:00:00.000Z', currencyCode: 'EUR', totalQuantity: 1, total: 800, totalWithTax: 952,
  customer: { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', emailAddress: 'ada@example.com' },
  lines: [], shippingLines: [], surcharges: [], subTotal: 800, subTotalWithTax: 952, shipping: 0, shippingWithTax: 0,
  taxSummary: [], discounts: [], couponCodes: [],
  customFields: { tallyClientOrderId: 'client-2', tallySaleAt: null, tallyRegisterId: 'reg-1', tallySessionId: null,
    tallyCashierRef: 'ref-1', tallyRejected: false, tallyRejectedClientOrderId: null, tallyPayments: null, tallySnapshot: null, tallyShipping: null },
  payments: ['cash', 'external', 'cash', 'external'].map((method, index) => ({ id: String(index), method: 'tally-pos',
    amount: 100, state: index === 3 ? 'Declined' : 'Settled', transactionId: '', createdAt: '2026-11-17T03:00:00.000Z',
    metadata: { tender: { method } }, refunds: [] })),
};

it('lists only supported filters and the placed-order status options', () => {
  expect(VENDURE_ORDER_FILTER_FIELDS).toEqual(['status', 'customerId', 'cashierId', 'registerId', 'dateRange']);
  expect(ORDER_STATUS_OPTIONS).toEqual([
    { value: 'PaymentAuthorized', label: 'Payment authorized' }, { value: 'PaymentSettled', label: 'Payment settled' },
    { value: 'PartiallyShipped', label: 'Partially shipped' }, { value: 'Shipped', label: 'Shipped' },
    { value: 'PartiallyDelivered', label: 'Partially delivered' }, { value: 'Delivered', label: 'Delivered' },
    { value: 'Cancelled', label: 'Cancelled' },
  ]);
});

it('omits unset options and whitespace-only search', () => {
  expect(orderListOptions({ search: '', filters: {} }, 'UTC', 0)).toStrictEqual({ skip: 0, take: 25 });
  expect(orderListOptions({ search: '   ', filters: {} }, 'UTC', 0)).toStrictEqual({ skip: 0, take: 25 });
});

it('maps supported filters, trims search and converts inclusive store days to UTC', () => {
  expect(orderListOptions({ search: '  ab12 ', filters: {
    status: 'Cancelled', customerId: 'c1', cashierId: 'ref-1', registerId: 'reg-1', paymentMethod: 'cash',
    storeId: 'store-1', createdVia: 'pos', dateRange: { from: '2026-11-16', to: '2026-11-16' },
  } }, 'America/New_York', 25)).toStrictEqual({ skip: 25, take: 25, state: ['Cancelled'], customerId: 'c1',
    tallyCashierRef: 'ref-1', tallyRegisterId: 'reg-1', search: 'ab12',
    orderPlacedAt: { after: '2026-11-16T05:00:00.000Z', before: '2026-11-17T05:00:00.000Z' } });
});

it('maps customer, store day, tenders, status and history to a table row', () => {
  expect(toOrderTableRow(order, 'America/New_York')).toEqual({ id: '2', code: 'AB12', stateLabel: 'Payment settled',
    status: 'completed', placedAt: order.orderPlacedAt, day: '2026-11-16', customer: 'Ada Lovelace', cashierRef: 'ref-1',
    paymentMethods: 'Cash, Card', totalMinor: 952, currency: 'EUR', history: toOrderHistoryRow(order) });
  expect(toOrderTableRow({ ...order, customer: null }, 'UTC').customer).toBeNull();
  expect(toOrderTableRow({ ...order, customer: { ...order.customer!, firstName: '', lastName: '' } }, 'UTC').customer).toBe('ada@example.com');
  const fallback = toOrderTableRow({ ...order, orderPlacedAt: null, customFields: undefined, payments: undefined }, 'UTC');
  expect(fallback).toMatchObject({ placedAt: order.updatedAt, day: '2026-11-18', cashierRef: null, paymentMethods: '' });
});

it("shows the plugin's walk-in as no customer, so its row reads Guest, and keeps a named customer's name", () => {
  expect(toOrderTableRow({ ...order, customer: { ...order.customer!, firstName: '', lastName: '', emailAddress: 'walk-in@vendurepos.invalid' } }, 'UTC').customer).toBeNull();
  expect(toOrderTableRow(order, 'UTC').customer).toBe('Ada Lovelace');
});

it('skips every unpaid state and falls back to the payment method for missing or empty tender methods', () => {
  const payment = order.payments![0];
  expect(toOrderTableRow({ ...order, payments: ['Declined', 'Error', 'Cancelled'].map(state => ({ ...payment, state })) }, 'UTC').paymentMethods).toBe('');
  expect(toOrderTableRow({ ...order, payments: [
    { ...payment, method: 'cash', metadata: null }, { ...payment, method: 'external', metadata: { tender: { method: '' } } },
    { ...payment, method: 'voucher', metadata: { tender: { method: 7 } } },
  ] }, 'UTC').paymentMethods).toBe('Cash, Card, voucher');
});

it('groups consecutive days in row order with relative and dated labels', () => {
  const rows = ['2026-11-16', '2026-11-16', '2026-11-15', '2025-12-30', '2025-12-30'].map((day, index) =>
    ({ ...toOrderTableRow(order, 'UTC'), id: String(index), day }));
  const groups = groupOrdersByDay(rows, '2026-11-16');
  expect(groups.map(group => group.label)).toEqual(['Today', 'Yesterday', expect.stringContaining('2025')]);
  expect(groups.map(group => group.rows)).toEqual([rows.slice(0, 2), rows.slice(2, 3), rows.slice(3)]);
  expect(groupOrdersByDay([rows[0], rows[2], rows[1]], '2026-11-16').map(group => group.rows)).toEqual([[rows[0]], [rows[2]], [rows[1]]]);
  expect(groupOrdersByDay([{ ...rows[0], day: '2025-12-31' }], '2026-01-01')[0].label).toBe('Yesterday');
});
