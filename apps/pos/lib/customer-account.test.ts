import type { SyncContext } from '@tallyui/core';
import { afterEach, expect, it, vi } from 'vitest';
import { CUSTOMER_ACCOUNT_QUERY, customerAccountText, readCustomerAccount } from './customer-account';

const context: SyncContext = {
  connectorId: 'vendure', baseUrl: 'https://shop.example.com',
  headers: { Authorization: 'Bearer test-token' }, signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());

it('customerAccountText names a guest, a verified and an unverified registration', () => {
  expect(customerAccountText(null)).toBe('Guest');
  expect(customerAccountText({ verified: true })).toBe('Registered · email verified');
  expect(customerAccountText({ verified: false })).toBe('Registered · not verified');
});

it('readCustomerAccount POSTs the account query for that customer and answers guest, verified, or null for an absent customer', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { customer: { id: 'c7', user: null } } }));
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerAccount(context, 'c7')).toBe('Guest');
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: CUSTOMER_ACCOUNT_QUERY, variables: { id: 'c7' } }),
  });
  fetch.mockResolvedValueOnce(Response.json({ data: { customer: { id: 'c3', user: { id: 'u3', verified: true } } } }))
    .mockResolvedValueOnce(Response.json({ data: { customer: null } }));
  expect(await readCustomerAccount(context, 'c3')).toBe('Registered · email verified');
  expect(await readCustomerAccount(context, 'nobody')).toBeNull();
});

it('readCustomerAccount rejects GraphQL errors and HTTP 403', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Forbidden' }] }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 })));
  await expect(readCustomerAccount(context, 'c1')).rejects.toThrow('Forbidden');
  await expect(readCustomerAccount(context, 'c1')).rejects.toThrow('HTTP 403');
});
