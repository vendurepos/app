import { afterEach, expect, it, vi } from 'vitest';
import { CustomerServiceError, type SyncContext } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import type { CustomerRow } from './customer-list';
import { CUSTOMER_EMAIL_REQUIRED_TEXT, CUSTOMER_OFFLINE_TEXT, CUSTOMER_SAVE_FORBIDDEN_TEXT,
  customerAccess, customerFormValues, customerInput, customerPatch, customerSaveError, saveCustomer } from './customer-edit';

const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
const row: CustomerRow = { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: null,
  billingAddress: [], createdAt: '2026-01-01T00:00:00.000Z' };
const values = customerFormValues(row);
const raw = { __typename: 'Customer', id: row.id, firstName: row.firstName, lastName: row.lastName, emailAddress: row.email, phoneNumber: null, addresses: [] };
const conflict = { __typename: 'EmailAddressConflictError', errorCode: 'EMAIL_ADDRESS_CONFLICT_ERROR', message: 'The email address is not available.' };
afterEach(() => vi.unstubAllGlobals());

it('prefills only the form fields, with no address and an empty null phone', () => {
  expect(values).toEqual({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '', address: '' });
  expect(customerFormValues(null)).toEqual({ firstName: '', lastName: '', email: '', phone: '', address: '' });
});
it('patches only changed, trimmed fields, including clearing a phone', () => {
  expect(customerPatch(row, { ...values, firstName: ' Ada ', lastName: ' King ', phone: ' ' })).toEqual({ lastName: 'King' });
  expect(customerPatch(row, values)).toEqual({});
  expect(customerPatch({ ...row, phone: '123' }, values)).toEqual({ phone: '' });
  expect(customerPatch(row, { ...values, firstName: ' ', email: ' new@example.com ', phone: ' 456 ' }))
    .toEqual({ firstName: '', email: 'new@example.com', phone: '456' });
  expect(customerPatch(row, { ...values, email: ' ' })).toEqual({ error: CUSTOMER_EMAIL_REQUIRED_TEXT });
});
it('trims create fields, omits an empty phone and requires email', () => {
  expect(customerInput({ firstName: ' Ada ', lastName: ' Lovelace ', email: ' ada@example.com ', phone: ' ', address: ' ignored ' }))
    .toEqual({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
  expect(customerInput({ ...values, firstName: ' ', lastName: ' ', phone: ' 123 ' }))
    .toEqual({ firstName: '', lastName: '', email: row.email, phone: '123' });
  expect(customerInput({ ...values, email: ' ' })).toEqual({ error: CUSTOMER_EMAIL_REQUIRED_TEXT });
});
it('creates once with trimmed variables and returns the store customer', async () => {
  const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { createCustomer: raw } })));
  vi.stubGlobal('fetch', fetchStub);
  await expect(saveCustomer(context, null, { ...values, firstName: ' ada ', lastName: ' Lovelace ', email: ' ada@example.com ', phone: ' ' }))
    .resolves.toEqual({ customer: { id: row.id, name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: row.email } });
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const request = JSON.parse(fetchStub.mock.calls[0][1]!.body as string);
  expect(request.query).toContain('createCustomer(');
  expect(request.variables).toEqual({ input: { emailAddress: row.email, firstName: 'ada', lastName: 'Lovelace' } });
});
it('returns the store reason when create is refused', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { createCustomer: conflict } }))));
  await expect(saveCustomer(context, null, values)).resolves.toEqual({ error: conflict.message });
});
it('edits only the changed field, without any address mutation', async () => {
  const fetchStub = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { customer: raw } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { updateCustomer: { ...raw, lastName: 'King' } } })));
  vi.stubGlobal('fetch', fetchStub);
  await expect(saveCustomer(context, row, { ...values, lastName: ' King ' })).resolves.toMatchObject({ customer: { lastName: 'King' } });
  expect(fetchStub).toHaveBeenCalledTimes(2);
  const requests = fetchStub.mock.calls.map(call => JSON.parse(call[1]!.body as string));
  expect(requests[0].query).toContain('query Addresses');
  expect(requests[1].query).toContain('updateCustomer(');
  expect(requests[1].variables).toEqual({ input: { id: row.id, lastName: 'King' } });
  expect(requests.filter(request => /mutation/.test(request.query))).toHaveLength(1);
  expect(requests.some(request => /(?:create|update)CustomerAddress/.test(request.query))).toBe(false);
});
it('returns the store reason when edit is refused', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { customer: raw } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { updateCustomer: conflict } }))));
  await expect(saveCustomer(context, row, { ...values, email: 'taken@example.com' })).resolves.toEqual({ error: conflict.message });
});
it.each([[403, CUSTOMER_SAVE_FORBIDDEN_TEXT], [401, SESSION_ENDED_TEXT]] as const)('maps HTTP %s on save', async (status, error) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
  await expect(saveCustomer(context, null, values)).resolves.toEqual({ error });
});
it('maps a rejected fetch to the offline words', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(saveCustomer(context, null, values)).resolves.toEqual({ error: CUSTOMER_OFFLINE_TEXT });
});
it('shows the GraphQL reason without the connector prefix', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'boom' }] }))));
  await expect(saveCustomer(context, null, values)).resolves.toEqual({ error: "The store didn't save this customer: boom." });
});
it('maps API errors and unknown errors, and preserves arbitrary store refusals', () => {
  expect(customerSaveError(new CustomerServiceError('server', 'Vendure API error: 500'))).toBe("The store didn't save this customer: 500.");
  expect(customerSaveError(new CustomerServiceError('invalid', 'A different store reason'))).toBe('A different store reason');
  expect(customerSaveError(new Error('unknown'))).toBe("The store didn't save this customer. Try again.");
});
it('makes no request for an empty edit patch or missing email', async () => {
  const fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
  await expect(saveCustomer(context, row, values)).resolves.toEqual({ error: 'Nothing to save.' });
  for (const target of [row, null]) {
    await expect(saveCustomer(context, target, { ...values, email: ' ' })).resolves.toEqual({ error: CUSTOMER_EMAIL_REQUIRED_TEXT });
  }
  expect(fetchStub).not.toHaveBeenCalled();
});
it.each([
  [['CreateCustomer'], 'active', { create: true, update: false }],
  [['CreateCustomer', 'UpdateCustomer'], 'active', { create: true, update: true }],
  [['CreateCustomer', 'UpdateCustomer'], 'other', { create: false, update: false }],
] as const)('reads customer permissions %s only on the active channel (%s)', async (permissions, id, expected) => {
  const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {
    me: { channels: [{ id, permissions }] }, activeChannel: { id: 'active' },
  } })));
  vi.stubGlobal('fetch', fetchStub);
  await expect(customerAccess(context)).resolves.toEqual(expected);
  expect(JSON.parse(fetchStub.mock.calls[0][1]!.body as string).query)
    .toBe('query CustomerPermissions { me { channels { id permissions } } activeChannel { id } }');
});
it('grants no access on GraphQL errors, HTTP failures or a rejected fetch', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'boom' }] })))
    .mockResolvedValueOnce(new Response('', { status: 403 }))
    .mockRejectedValueOnce(new TypeError('Failed to fetch')));
  for (let i = 0; i < 3; i++) await expect(customerAccess(context)).resolves.toEqual({ create: false, update: false });
});
