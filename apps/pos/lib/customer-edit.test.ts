import { afterEach, expect, it, vi } from 'vitest';
import { CustomerServiceError, type SyncContext } from '@tallyui/core';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import type { CustomerRow } from './customer-list';
import type { updateVendureCustomer } from '@tallyui/connector-vendure';
import { ADDRESS_FIELDS_QUERY, addressEditorAllowed, addressEditorValue, addressPatch, CUSTOMER_ADDRESS_REMOVE_TEXT, CUSTOMER_ADDRESS_REQUIRED_TEXT, CUSTOMER_ADDRESS_STALE_TEXT,
  readAddressCustomFields, CUSTOMER_EMAIL_REQUIRED_TEXT, CUSTOMER_OFFLINE_TEXT, CUSTOMER_SAVE_FORBIDDEN_TEXT,
  customerAccess, customerFormValues, customerInput, customerPatch, customerSaveError, readCustomerAddresses, saveCustomer } from './customer-edit';

const context = { baseUrl: 'https://store.test', headers: {} } as SyncContext;
const row: CustomerRow = { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: null,
  billingAddress: [], groups: [], createdAt: '2026-01-01T00:00:00.000Z' };
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

// A full stored billing address and a different shipping address, as Vendure's customers list answers them.
const billingRaw = { id: 'b1', fullName: 'Ada Lovelace', company: 'Engines Ltd', streetLine1: '12 Engine Row', streetLine2: 'Flat 2', city: 'London',
  province: 'Greater London', postalCode: 'N1 9GU', country: { code: 'GB' }, phoneNumber: '+44 20 7946 0000', defaultBillingAddress: true, defaultShippingAddress: false };
const shippingRaw = { id: 's1', fullName: 'Ada King', company: 'Analytical Works', streetLine1: '1 Dock Road', streetLine2: 'Unit 3', city: 'Bristol',
  province: 'Avon', postalCode: 'BS1 1AA', country: { code: 'GB' }, phoneNumber: '+44 117 496 0000', defaultBillingAddress: false, defaultShippingAddress: true };
type PatchInput = Parameters<typeof updateVendureCustomer>[2];
function storeStub(addresses: Record<string, unknown>[]) {
  const fetchStub = vi.fn<typeof fetch>(async (_url, init) => {
    const { query } = JSON.parse(init!.body as string);
    const name = /^\s*(?:query|mutation) (\w+)/.exec(query)![1];
    const data = name === 'List' ? { customers: { totalItems: 1, items: [{ ...raw, createdAt: '2026-01-01T00:00:00.000Z', addresses }] } }
      : name === 'Addresses' ? { customer: { ...raw, addresses } } : name === 'Create' ? { createCustomer: raw }
      : name === 'CreateAddress' ? { createCustomerAddress: { id: 'n1' } } : { updateCustomerAddress: { id: 'x' } };
    return new Response(JSON.stringify({ data }));
  });
  vi.stubGlobal('fetch', fetchStub);
  return () => fetchStub.mock.calls.map(call => JSON.parse(call[1]!.body as string) as { query: string; variables: Record<string, any> });
}
const writes = (requests: { query: string; variables: Record<string, any> }[]) => requests.filter(request => /^\s*mutation/.test(request.query));
it('round trip: editing only the billing city writes billing whole with only the city changed, and never touches shipping', async () => {
  const requests = storeStub([billingRaw, shippingRaw]);
  const stored = (await readCustomerAddresses(context, row.id))!;
  const edited = addressEditorValue(stored);
  expect(edited.shipping).toEqual(stored.shipping);
  const patch: PatchInput | { error: string } = addressPatch(stored, { ...edited, billing: { ...edited.billing, city: 'Cambridge' } });
  expect(patch).toEqual({ billing: { ...stored.billing, city: 'Cambridge' } });
  expect('shipping' in patch).toBe(false);
  await expect(saveCustomer(context, row, values, { stored, edited: { ...edited, billing: { ...edited.billing, city: 'Cambridge' } } }))
    .resolves.toMatchObject({ customer: { id: row.id } });
  const { id, defaultBillingAddress: _b, defaultShippingAddress: _s, country, ...rest } = billingRaw;
  expect(writes(requests())).toEqual([{ query: expect.stringContaining('updateCustomerAddress'),
    variables: { input: { ...rest, id, countryCode: country.code, city: 'Cambridge' } } }]);
});
it('sends a cleared field as cleared and keeps every other field', () => {
  const stored = { billing: { firstName: 'Ada Lovelace', address1: '12 Engine Row', address2: 'Flat 2', city: 'London', country: 'GB' } };
  const { address2: _cleared, ...billing } = stored.billing;
  expect(addressPatch(stored, { billing })).toEqual({ billing: { ...stored.billing, address2: '' } });
});
it('gives a customer with no address a billing address only, and an untouched or empty one none', async () => {
  const billing = { address1: '5 Mill Lane', city: 'Leeds', country: 'GB', email: 'not-stored@example.com' };
  expect(addressPatch({}, { billing })).toEqual({ billing: { address1: '5 Mill Lane', city: 'Leeds', country: 'GB' } });
  expect(addressPatch({}, { billing: {} })).toEqual({});
  const requests = storeStub([]);
  await expect(saveCustomer(context, null, values, { stored: {}, edited: { billing } })).resolves.toMatchObject({ customer: { id: row.id } });
  const [create, address, ...more] = writes(requests());
  expect(create.query).toContain('createCustomer(');
  expect(address.variables).toEqual({ customerId: row.id, input: { fullName: '', company: '', streetLine1: '5 Mill Lane', streetLine2: '', city: 'Leeds',
    province: '', postalCode: '', countryCode: 'GB', phoneNumber: '', defaultBillingAddress: true } });
  expect(more).toEqual([]);
});
it('follows billing for a shipping address shown as Same as billing, and refuses an incomplete or removed address before any request', async () => {
  const shared = { billing: { address1: '12 Engine Row', city: 'London', country: 'GB' }, shipping: { address1: '12 Engine Row', city: 'London', country: 'GB' } };
  const edited = addressEditorValue(shared);
  expect(edited).toEqual({ billing: shared.billing, shipping: undefined });
  const billing = { ...shared.billing, city: 'Cambridge' };
  expect(addressPatch(shared, { ...edited, billing })).toEqual({ billing, shipping: billing });
  const fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
  for (const target of [row, null]) {
    await expect(saveCustomer(context, target, values, { stored: target ? shared : {}, edited: { billing: { city: 'Leeds' } } }))
      .resolves.toEqual({ error: CUSTOMER_ADDRESS_REQUIRED_TEXT });
  }
  await expect(saveCustomer(context, row, values, { stored: shared, edited: { billing: undefined } })).resolves.toEqual({ error: CUSTOMER_ADDRESS_REMOVE_TEXT });
  expect(fetchStub).not.toHaveBeenCalled();
});

const config = (Address: { name: string }[]) => new Response(JSON.stringify({ data: { globalSettings: { serverConfig: { customFieldConfig: { Address } } } } }));
it('offers the address editor only on a store with no Address custom fields', async () => {
  const fetchStub = vi.fn<typeof fetch>().mockResolvedValueOnce(config([{ name: 'gateCode' }])).mockResolvedValueOnce(config([]));
  vi.stubGlobal('fetch', fetchStub);
  await expect(addressEditorAllowed(readAddressCustomFields(context))).resolves.toBe(false);
  await expect(addressEditorAllowed(readAddressCustomFields(context))).resolves.toBe(true);
  expect(fetchStub.mock.calls[0][0]).toBe('https://store.test/admin-api');
  expect(JSON.parse(fetchStub.mock.calls[0][1]!.body as string).query).toBe(ADDRESS_FIELDS_QUERY);
});
it('offers no address editor when the custom-field config read fails', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'Cannot query field' }] })))
    .mockRejectedValueOnce(new TypeError('Failed to fetch')));
  for (let i = 0; i < 3; i++) await expect(addressEditorAllowed(readAddressCustomFields(context))).resolves.toBe(false);
});
it('re-reads the addresses before an address write, and writes nothing when they changed or the read fails', async () => {
  const live = [billingRaw, shippingRaw];
  const requests = storeStub(live);
  const stored = (await readCustomerAddresses(context, row.id))!;
  const edited = { ...addressEditorValue(stored), billing: { ...stored.billing, city: 'Cambridge' } };
  await expect(saveCustomer(context, row, values, { stored, edited })).resolves.toMatchObject({ customer: { id: row.id } });
  expect(requests().filter(request => /^\s*query List\b/.test(request.query))).toHaveLength(2);
  expect(writes(requests())).toHaveLength(1);
  live[0] = { ...billingRaw, city: 'Oxford' };
  const before = requests().length;
  await expect(saveCustomer(context, row, { ...values, lastName: 'King' }, { stored, edited })).resolves.toEqual({ error: CUSTOMER_ADDRESS_STALE_TEXT });
  expect(writes(requests().slice(before))).toEqual([]);
  const failing = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
  vi.stubGlobal('fetch', failing);
  await expect(saveCustomer(context, row, values, { stored, edited })).resolves.toEqual({ error: CUSTOMER_ADDRESS_STALE_TEXT });
  expect(failing).toHaveBeenCalledTimes(1);
});
const inputOf = (address: typeof billingRaw) => {
  const { id: _id, defaultBillingAddress: _b, defaultShippingAddress: _s, country, ...rest } = address;
  return { ...rest, countryCode: country.code };
};
it('round trip: a shipping-only edit writes shipping whole and never sends billing', async () => {
  const requests = storeStub([billingRaw, shippingRaw]);
  const stored = (await readCustomerAddresses(context, row.id))!;
  const edited = addressEditorValue(stored);
  await expect(saveCustomer(context, row, values, { stored, edited: { ...edited, shipping: { ...edited.shipping, city: 'Bath' } } }))
    .resolves.toMatchObject({ customer: { id: row.id } });
  expect(writes(requests())).toEqual([{ query: expect.stringContaining('updateCustomerAddress'),
    variables: { input: { id: shippingRaw.id, ...inputOf(shippingRaw), city: 'Bath' } } }]);
});
it('round trip: one shared address with billing edited and shipping Same as billing keeps every stored input but the city', async () => {
  const sharedRaw = { ...billingRaw, defaultShippingAddress: true };
  const requests = storeStub([sharedRaw]);
  const stored = (await readCustomerAddresses(context, row.id))!;
  const edited = addressEditorValue(stored);
  expect(edited.shipping).toBeUndefined();
  await expect(saveCustomer(context, row, values, { stored, edited: { ...edited, billing: { ...edited.billing, city: 'Cambridge' } } }))
    .resolves.toMatchObject({ customer: { id: row.id } });
  const inputs = { ...inputOf(sharedRaw), city: 'Cambridge' };
  // connector-vendure: billing moves to a new address, the shared one loses its billing flag, then takes the shipping write.
  expect(writes(requests())).toEqual([
    { query: expect.stringContaining('createCustomerAddress'), variables: { customerId: row.id, input: { ...inputs, defaultBillingAddress: true } } },
    { query: expect.stringContaining('updateCustomerAddress'), variables: { input: { id: sharedRaw.id, defaultBillingAddress: false } } },
    { query: expect.stringContaining('updateCustomerAddress'), variables: { input: { id: sharedRaw.id, ...inputs } } },
  ]);
});
it('round trip: a cleared field goes through the connector as cleared, the rest as stored', async () => {
  const requests = storeStub([billingRaw, shippingRaw]);
  const stored = (await readCustomerAddresses(context, row.id))!;
  const edited = addressEditorValue(stored);
  await expect(saveCustomer(context, row, values, { stored, edited: { ...edited, billing: { ...edited.billing, address2: '' } } }))
    .resolves.toMatchObject({ customer: { id: row.id } });
  expect(writes(requests())).toEqual([{ query: expect.stringContaining('updateCustomerAddress'),
    variables: { input: { id: billingRaw.id, ...inputOf(billingRaw), streetLine2: '' } } }]);
});
