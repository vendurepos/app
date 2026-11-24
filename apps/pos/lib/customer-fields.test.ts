import type { SyncContext } from '@tallyui/core';
import { afterEach, expect, it, vi } from 'vitest';
import { CUSTOMER_FIELD_CONFIG_QUERY, CUSTOMER_FIELD_EMPTY, customerFieldDefs, customerFieldsQuery, customerFieldValue, readCustomerFields, type CustomerFieldDef } from './customer-fields';

const context: SyncContext = {
  connectorId: 'vendure', baseUrl: 'https://shop.example.com',
  headers: { Authorization: 'Bearer test-token' }, signal: new AbortController().signal,
};
const defs: CustomerFieldDef[] = [
  { name: 'taxId', label: 'Tax ID', type: 'string', list: false },
  { name: 'wholesale', label: 'Wholesale', type: 'boolean', list: false },
];
const config = { data: { globalSettings: { serverConfig: { entityCustomFields: [{ entityName: 'Customer',
  customFields: defs.map(def => ({ ...def, label: [{ languageCode: 'en', value: def.label }] })),
}] } } } };
afterEach(() => vi.unstubAllGlobals());

it('customerFieldDefs keeps Customer fields in order, excludes internal, relation, struct and invalid names, and selects labels', () => {
  expect(customerFieldDefs([
    { entityName: 'ProductVariant', customFields: [{ name: 'barcode', type: 'string', list: false }] },
    { entityName: 'Customer', customFields: [
      { name: 'taxId', type: 'string', list: false, label: [{ languageCode: 'de', value: 'Steuer-ID' }, { languageCode: 'en', value: 'Tax ID' }] },
      { name: 'hidden', type: 'string', list: false, internal: true },
      { name: 'relation', type: 'relation', list: false },
      { name: 'struct', type: 'struct', list: false },
      { name: 'bad-name', type: 'string', list: false },
      { name: 'notes', type: 'text', list: true, label: [{ languageCode: 'de', value: 'Notizen' }] },
      { name: '_code2', type: 'int', list: false },
    ] },
  ], [])).toEqual([defs[0], { name: 'notes', label: 'Notizen', type: 'text', list: true }, { name: '_code2', label: '_code2', type: 'int', list: false }]);
  expect(customerFieldDefs([{ entityName: 'Product', customFields: [{ name: 'code', type: 'string', list: false }] }], [])).toEqual([]);
});

it('customerFieldDefs leaves out a field gated by a permission the role lacks; any one listed permission is enough', () => {
  const entities = [{ entityName: 'Customer', customFields: [
    { name: 'open', type: 'string', list: false },
    { name: 'empty', type: 'string', list: false, requiresPermission: [] },
    { name: 'nulled', type: 'string', list: false, requiresPermission: null },
    { name: 'anyOf', type: 'string', list: false, requiresPermission: ['SuperAdmin', 'ReadCustomer'] },
    { name: 'gated', type: 'string', list: false, requiresPermission: ['SuperAdmin'] },
  ] }];
  expect(customerFieldDefs(entities, ['ReadCustomer']).map(def => def.name)).toEqual(['open', 'empty', 'nulled', 'anyOf']);
  expect(customerFieldDefs(entities, null).map(def => def.name)).toEqual(['open', 'empty', 'nulled', 'anyOf', 'gated']);
});

it('customerFieldValue formats strings, numbers, booleans, dates, lists and empty values', () => {
  expect(customerFieldValue(defs[0], 'GB1')).toBe('GB1');
  expect(customerFieldValue({ ...defs[0], type: 'int' }, 42)).toBe('42');
  expect(customerFieldValue({ ...defs[0], type: 'float' }, 1.5)).toBe('1.5');
  expect(customerFieldValue(defs[1], true)).toBe('Yes');
  expect(customerFieldValue(defs[1], false)).toBe('No');
  const date = '2026-10-01T10:00:00.000Z';
  expect(customerFieldValue({ ...defs[0], type: 'datetime' }, date)).toBe(new Date(date).toLocaleDateString(undefined, { dateStyle: 'medium' }));
  expect(customerFieldValue({ ...defs[0], list: true }, ['a', 'b'])).toBe('a, b');
  expect(CUSTOMER_FIELD_EMPTY).toBe('—');
  for (const raw of [null, undefined, '', []]) expect(customerFieldValue(defs[0], raw)).toBe('—');
});

it('customerFieldsQuery selects exactly the two configured fields', () => {
  expect(customerFieldsQuery(defs)).toBe('query CustomerCustomFields($id: ID!) { customer(id: $id) { id customFields { taxId wholesale } } }');
});

it('readCustomerFields POSTs the config and customer queries and returns rows in config order', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json({ data: { customer: { id: 'c1', customFields: { wholesale: true, taxId: 'GB1' } } } }));
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerFields(context, 'c1')).toEqual([
    { name: 'taxId', label: 'Tax ID', value: 'GB1' }, { name: 'wholesale', label: 'Wholesale', value: 'Yes' },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenNthCalledWith(1, `${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: CUSTOMER_FIELD_CONFIG_QUERY }),
  });
  expect(fetch).toHaveBeenNthCalledWith(2, `${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: customerFieldsQuery(defs), variables: { id: 'c1' } }),
  });
});

it('readCustomerFields returns no rows after one fetch when there are no Customer fields', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { globalSettings: { serverConfig: { entityCustomFields: [] } } } }));
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerFields(context, 'c1')).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

const gatedConfig = { data: { globalSettings: { serverConfig: { entityCustomFields: [{ entityName: 'Customer', customFields: [
  { name: 'taxId', type: 'string', list: false, requiresPermission: ['SuperAdmin'] },
] }] } } } };

it('readCustomerFields reads the till\'s permissions from /tally/v1/info only when a field is gated, and leaves out a field the role lacks', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(gatedConfig)).mockResolvedValueOnce(Response.json({ permissions: ['ReadCustomer'] }));
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerFields(context, 'c1')).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toBe('https://shop.example.com/tally/v1/info');
  expect(fetch.mock.calls[1][1]).toEqual({ headers: context.headers, signal: context.signal });
});

it('readCustomerFields keeps a gated field the device-key till\'s role reads by /tally/v1/info', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(gatedConfig)).mockResolvedValueOnce(Response.json({ permissions: ['SuperAdmin'] }))
    .mockResolvedValueOnce(Response.json({ data: { customer: { id: 'c1', customFields: { taxId: 'GB1' } } } }));
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerFields(context, 'c1')).toEqual([{ name: 'taxId', label: 'taxId', value: 'GB1' }]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('readCustomerFields on a plugin older than #487 reads the active channel\'s permissions from Admin me', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(gatedConfig)).mockResolvedValueOnce(Response.json({ contracts: {} }))
    .mockResolvedValueOnce(Response.json({ data: {
      me: { channels: [{ id: '1', permissions: ['SuperAdmin'] }, { id: '2', permissions: ['ReadCustomer'] }] }, activeChannel: { id: '2' },
    } }));
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerFields(context, 'c1')).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[2][1].body).toBe(JSON.stringify({ query: 'query TillPermissions { me { channels { id permissions } } activeChannel { id } }' }));
});

it('readCustomerFields keeps a gated field when the till\'s permissions cannot be read, as on a device-key till on an older plugin', async () => {
  const values = () => Response.json({ data: { customer: { id: 'c1', customFields: { taxId: 'GB1' } } } });
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(gatedConfig)).mockResolvedValueOnce(Response.json({ contracts: {} }))
    .mockResolvedValueOnce(Response.json({ data: { me: null, activeChannel: { id: '1' } },
      errors: [{ message: 'You are not currently authorized to perform this action', path: ['me'] }] }))
    .mockResolvedValueOnce(values());
  vi.stubGlobal('fetch', fetch);
  expect(await readCustomerFields(context, 'c1')).toEqual([{ name: 'taxId', label: 'taxId', value: 'GB1' }]);
  expect(fetch).toHaveBeenCalledTimes(4);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(gatedConfig)).mockResolvedValueOnce(Response.json({}, { status: 500 }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 })).mockResolvedValueOnce(values()));
  expect(await readCustomerFields(context, 'c1')).toEqual([{ name: 'taxId', label: 'taxId', value: 'GB1' }]);
});

it('readCustomerFields returns null for an absent customer', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(config)).mockResolvedValueOnce(Response.json({ data: { customer: null } })));
  expect(await readCustomerFields(context, 'unknown')).toBeNull();
});

it('readCustomerFields rejects GraphQL errors and HTTP 403', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Forbidden' }, { message: 'Second error' }] }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 })));
  await expect(readCustomerFields(context, 'c1')).rejects.toThrow('Forbidden');
  await expect(readCustomerFields(context, 'c1')).rejects.toThrow('HTTP 403');
});
