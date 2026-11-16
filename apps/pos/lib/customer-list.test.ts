import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, type SyncContext } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { CUSTOMERS_FAILED_TEXT, CUSTOMERS_FORBIDDEN_TEXT, customerListNotice, customerListOptions,
  customersReadable, listVendureCustomerPage, toCustomerRow, type VendureCustomerListItem } from './customer-list';

afterEach(() => vi.unstubAllGlobals());

it('lists the first page by last name and excludes the walk-in customer', () => {
  expect(customerListOptions('', 0)).toEqual({ skip: 0, take: 25, sort: { lastName: 'ASC' },
    filter: { emailAddress: { notEq: 'walk-in@vendurepos.local' } } });
});

it('trims search across names, email and phone while excluding the walk-in customer', () => {
  expect(customerListOptions('  mead ', 25)).toEqual({ skip: 25, take: 25, sort: { lastName: 'ASC' }, filter: {
    emailAddress: { notEq: 'walk-in@vendurepos.local' },
    _or: [{ firstName: { contains: 'mead' } }, { lastName: { contains: 'mead' } },
      { emailAddress: { contains: 'mead' } }, { phoneNumber: { contains: 'mead' } }],
  } });
});

const customer: VendureCustomerListItem = { id: 'c1', firstName: 'Ada', lastName: 'Lovelace',
  emailAddress: 'ada@example.com', phoneNumber: '1234', createdAt: '2026-02-03T10:00:00.000Z' };

it('uses the flagged billing address and drops empty address parts', () => {
  expect(toCustomerRow({ ...customer, addresses: [
    { fullName: 'Other', streetLine1: 'Other street', defaultBillingAddress: false },
    { fullName: 'Ada Lovelace', company: '', streetLine1: '12 Engine Row', streetLine2: '', city: 'London',
      province: null, postalCode: 'N1 9GU', country: { code: 'GB' }, defaultBillingAddress: true },
  ] })).toEqual({ id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '1234',
    createdAt: customer.createdAt, billingAddress: ['Ada Lovelace', '12 Engine Row', 'London N1 9GU', 'GB'] });
});

it('does not fall back to another address and maps missing strings and phone', () => {
  expect(toCustomerRow({ id: 'c2', createdAt: customer.createdAt, addresses: [
    { fullName: 'Other', streetLine1: 'Other street', defaultBillingAddress: false },
  ] })).toEqual({ id: 'c2', firstName: '', lastName: '', email: '', phone: null,
    createdAt: customer.createdAt, billingAddress: [] });
});

it('maps an HTTP 200 GraphQL FORBIDDEN error to unauthorized status 403', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [
    { message: 'You are not currently authorized', extensions: { code: 'FORBIDDEN' } },
  ] }), { status: 200 })));
  const request = listVendureCustomerPage({ baseUrl: 'https://store.test', headers: {} } as SyncContext, customerListOptions('', 0));
  await expect(request).rejects.toBeInstanceOf(ConnectorUnauthorizedError);
  await expect(request).rejects.toMatchObject({ status: 403, message: 'You are not currently authorized' });
});

it('a role without Read customer gets no Customers door and no customer data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [
    { message: 'You are not currently authorized', extensions: { code: 'FORBIDDEN' } },
  ] }), { status: 200 })));
  await expect(customersReadable({ baseUrl: 'https://store.test', headers: {} } as SyncContext)).resolves.toBe(false);
});

it('the readability probe asks for no customers', async () => {
  const fetchStub = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { customers: { totalItems: 8, items: [] } } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchStub);
  await expect(customersReadable({ baseUrl: 'https://store.test', headers: {} } as SyncContext)).resolves.toBe(true);
  expect(fetchStub).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchStub.mock.calls[0][1]!.body as string).variables.options.take).toBe(0);
});

it('an ended session or a failure keeps the door', async () => {
  for (const status of [401, 500]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(customersReadable({ baseUrl: 'https://store.test', headers: {} } as SyncContext)).resolves.toBe(true);
  }
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
  await expect(customersReadable({ baseUrl: 'https://store.test', headers: {} } as SyncContext)).resolves.toBe(true);
});

it('distinguishes a missing permission, an ended session and a retryable failure', () => {
  expect(customerListNotice(new ConnectorUnauthorizedError('forbidden', 403))).toEqual({ text: CUSTOMERS_FORBIDDEN_TEXT, retry: false });
  expect(customerListNotice(new ConnectorUnauthorizedError('unauthorized', 401))).toEqual({ text: SESSION_ENDED_TEXT, retry: false });
  expect(customerListNotice(new Error('x'))).toEqual({ text: CUSTOMERS_FAILED_TEXT, retry: true });
});
