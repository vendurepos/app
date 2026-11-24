import { afterEach, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { CUSTOMER_ADDRESS_REMOVE_FORBIDDEN_TEXT, CUSTOMER_ADDRESS_REMOVE_UNREACHED_TEXT, DELETE_ADDRESS_MUTATION, readSavedAddresses, removableAddresses, removeConfirmText, removeCustomerAddress,
  SAVED_ADDRESSES_QUERY, type SavedAddress } from './customer-address-remove';

const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const address = (id: string, billing: boolean, shipping: boolean): SavedAddress => ({ id, street: '12 Engine Row', city: 'London', billing, shipping });
afterEach(() => vi.unstubAllGlobals());

it('reads the saved addresses in Vendure order, maps a null city to empty, gives [] for no customer and rejects a GraphQL error', async () => {
  const fetchStub = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json({ data: { customer: { addresses: [
      { id: 'a1', streetLine1: '12 Engine Row', city: 'London', defaultBillingAddress: true, defaultShippingAddress: false },
      { id: 'a2', streetLine1: '1 Second St', city: null, defaultBillingAddress: false, defaultShippingAddress: true },
    ] } } }))
    .mockResolvedValueOnce(json({ data: { customer: null } }))
    .mockResolvedValueOnce(json({ errors: [{ message: 'boom' }] }));
  vi.stubGlobal('fetch', fetchStub);
  await expect(readSavedAddresses(context, 'c1')).resolves.toEqual([
    { id: 'a1', street: '12 Engine Row', city: 'London', billing: true, shipping: false },
    { id: 'a2', street: '1 Second St', city: '', billing: false, shipping: true },
  ]);
  expect(fetchStub.mock.calls[0][0]).toBe('https://store.test/admin-api');
  expect(JSON.parse(fetchStub.mock.calls[0][1]!.body as string)).toEqual({ query: SAVED_ADDRESSES_QUERY, variables: { id: 'c1' } });
  await expect(readSavedAddresses(context, 'c1')).resolves.toEqual([]);
  await expect(readSavedAddresses(context, 'c1')).rejects.toThrow('boom');
});

it('offers the default billing address first, then the default shipping one, and an address that is both once', () => {
  const other = address('a1', false, false), shipping = address('a2', false, true), billing = address('a3', true, false), both = address('a4', true, true);
  expect(removableAddresses([other, shipping, billing])).toEqual([billing, shipping]);
  expect(removableAddresses([other, both])).toEqual([both]);
  expect(removableAddresses([other])).toEqual([]);
});

it('names the address and says which address Vendure makes the default, or that there is none', () => {
  const both = address('a1', true, true);
  expect(removeConfirmText(both, [both], 'Ada Lovelace')).toEqual([
    "Remove 12 Engine Row, London from Ada Lovelace's account in Vendure?",
    'It is the default billing and shipping address, and the customer has no other saved address.',
  ]);
  expect(removeConfirmText(both, [both, address('a2', false, false)], 'Ada Lovelace')[1])
    .toBe("It is the default billing and shipping address, so Vendure makes the customer's oldest other saved address the default.");
  expect(removeConfirmText(address('a1', false, true), [address('a1', false, true)], 'Ada Lovelace')[1])
    .toBe('It is the default shipping address, and the customer has no other saved address.');
  const noCity = { ...both, city: '' };
  expect(removeConfirmText(noCity, [noCity], 'Ada Lovelace')[0]).toBe("Remove 12 Engine Row from Ada Lovelace's account in Vendure?");
});

it('removes one address and maps every refusal to its text', async () => {
  const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(json({ data: { deleteCustomerAddress: { success: true } } }));
  vi.stubGlobal('fetch', fetchStub);
  await expect(removeCustomerAddress(context, 'a1')).resolves.toEqual({ ok: true });
  expect(fetchStub.mock.calls[0][0]).toBe('https://store.test/admin-api');
  expect(JSON.parse(fetchStub.mock.calls[0][1]!.body as string)).toEqual({ query: DELETE_ADDRESS_MUTATION, variables: { id: 'a1' } });

  const answers: [Response | Error, unknown][] = [
    [json({ errors: [{ message: 'Forbidden' }] }, 403), { error: CUSTOMER_ADDRESS_REMOVE_FORBIDDEN_TEXT }],
    [json({ errors: [{ message: 'You are not currently authorized', extensions: { code: 'FORBIDDEN' } }], data: null }), { error: CUSTOMER_ADDRESS_REMOVE_FORBIDDEN_TEXT }],
    [new Response('', { status: 401 }), { error: SESSION_ENDED_TEXT }],
    [json({ errors: [{ message: 'Address is in use' }] }), { error: "The store didn't remove this address, so it is still saved: Address is in use." }],
    [json({ data: { deleteCustomerAddress: { success: false } } }), { error: "The store didn't remove this address, so it is still saved. Try again." }],
    [json({ errors: [{ message: 'No Address with the id "a1" could be found', extensions: { code: 'ENTITY_NOT_FOUND' } }], data: null }), { ok: true }],
    [new TypeError('Failed to fetch'), { error: CUSTOMER_ADDRESS_REMOVE_UNREACHED_TEXT }],
  ];
  for (const [answer, expected] of answers) {
    vi.stubGlobal('fetch', answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer));
    await expect(removeCustomerAddress(context, 'a1')).resolves.toEqual(expected);
  }
});
