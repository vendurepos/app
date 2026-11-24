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
  ])).toEqual([defs[0], { name: 'notes', label: 'Notizen', type: 'text', list: true }, { name: '_code2', label: '_code2', type: 'int', list: false }]);
  expect(customerFieldDefs([{ entityName: 'Product', customFields: [{ name: 'code', type: 'string', list: false }] }])).toEqual([]);
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
