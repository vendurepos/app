import { afterEach, expect, it, vi } from 'vitest';
import { CUSTOMER_ORDERS_TAKE, loadCustomerOrders } from './customer-orders';
import { ORDER_HISTORY_FAILED_TEXT, ORDER_HISTORY_FORBIDDEN_TEXT } from './order-history';
import type { Session } from './session';

const session = { url: 'https://shop.example.com', email: 'till@example.com', token: 'test-token', settings: {}, stock: { trackInventory: true, outOfStockThreshold: 0 } } as Session;
afterEach(() => vi.unstubAllGlobals());

it("loadCustomerOrders reads that customer's 5 newest orders and returns the items", async () => {
  const items = [{ id: '7', code: 'ABC7' }, { id: '3', code: 'ABC3' }];
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { customer: { orders: { items, totalItems: 2 } } } }));
  vi.stubGlobal('fetch', fetch);
  expect(await loadCustomerOrders(session, 'c1')).toEqual({ orders: items });
  expect(CUSTOMER_ORDERS_TAKE).toBe(5);
  expect(fetch).toHaveBeenCalledOnce();
  const { variables } = JSON.parse(fetch.mock.calls[0][1].body);
  expect(variables.customerId).toBe('c1');
  expect(variables.options).toMatchObject({ skip: 0, take: 5, sort: { orderPlacedAt: 'DESC', id: 'DESC' } });
});

it('loadCustomerOrders answers a 403 with the forbidden notice', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({}, { status: 403 })));
  expect(await loadCustomerOrders(session, 'c1')).toEqual({ notice: { text: ORDER_HISTORY_FORBIDDEN_TEXT, retry: false } });
});

it('loadCustomerOrders answers a network error with the failed notice and a retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
  expect(await loadCustomerOrders(session, 'c1')).toEqual({ notice: { text: ORDER_HISTORY_FAILED_TEXT, retry: true } });
});
