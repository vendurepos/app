import type { SyncContext } from '@tallyui/core';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ADD_CUSTOMER_NOTE_MUTATION, addCustomerNote, CUSTOMER_NOTE_FAILED_TEXT, CUSTOMER_NOTE_FORBIDDEN_TEXT, CUSTOMER_NOTE_OPTIONS,
  CUSTOMER_NOTES_QUERY, listCustomerNotes,
} from './customer-notes';

const context: SyncContext = {
  connectorId: 'vendure', baseUrl: 'https://shop.example.com',
  headers: { Authorization: 'Bearer test-token' }, signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());

it('listCustomerNotes POSTs the notes query and options, trims notes, drops blank ones and returns none for an absent customer', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { customer: { id: 'c1', history: { items: [
    { id: 'h2', isPublic: true, data: { note: 'Second' } },
    { id: 'blank', isPublic: false, data: { note: '   ' } },
    { id: 'missing', isPublic: false, data: {} },
    { id: 'h1', isPublic: false, data: { note: ' Prefers oat milk \n' } },
  ] } } } })).mockResolvedValueOnce(Response.json({ data: { customer: null } }));
  vi.stubGlobal('fetch', fetch);
  expect(await listCustomerNotes(context, 'c1')).toEqual([{ id: 'h1', text: 'Prefers oat milk' }, { id: 'h2', text: 'Second' }]);
  expect(CUSTOMER_NOTE_OPTIONS).toEqual({ take: 100, sort: { createdAt: 'DESC' }, filter: { type: { eq: 'CUSTOMER_NOTE' } } });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: CUSTOMER_NOTES_QUERY, variables: { id: 'c1', options: CUSTOMER_NOTE_OPTIONS } }),
  });
  expect(await listCustomerNotes(context, 'c1')).toEqual([]);
});

it('listCustomerNotes rejects GraphQL errors and HTTP 403', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Forbidden' }] }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 })));
  await expect(listCustomerNotes(context, 'c1')).rejects.toThrow('Forbidden');
  await expect(listCustomerNotes(context, 'c1')).rejects.toThrow('HTTP 403');
});

it('addCustomerNote POSTs the trimmed note as a private note on that customer and answers ok', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { addNoteToCustomer: { id: 'c1' } } }));
  vi.stubGlobal('fetch', fetch);
  expect(await addCustomerNote(context, 'c1', '  Oat milk \n')).toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: ADD_CUSTOMER_NOTE_MUTATION, variables: { input: { id: 'c1', note: 'Oat milk', isPublic: false } } }),
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body).variables).toEqual({ input: { id: 'c1', note: 'Oat milk', isPublic: false } });
});

it('addCustomerNote refuses a blank note without a request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await addCustomerNote(context, 'c1', ' \n ')).toEqual({ error: CUSTOMER_NOTE_FAILED_TEXT });
  expect(fetch).not.toHaveBeenCalled();
});

it('addCustomerNote maps FORBIDDEN and HTTP 403 to the permission text, and anything else to the failed text', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ errors: [{ message: 'You are not currently authorized', extensions: { code: 'FORBIDDEN' } }], data: null }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ errors: [{ message: 'No Customer with the id "9"', extensions: { code: 'ENTITY_NOT_FOUND' } }], data: null }))
    .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
    .mockRejectedValueOnce(new TypeError('Failed to fetch')));
  expect(await addCustomerNote(context, 'c1', 'Oat milk')).toEqual({ error: CUSTOMER_NOTE_FORBIDDEN_TEXT });
  expect(await addCustomerNote(context, 'c1', 'Oat milk')).toEqual({ error: CUSTOMER_NOTE_FORBIDDEN_TEXT });
  expect(await addCustomerNote(context, '9', 'Oat milk')).toEqual({ error: CUSTOMER_NOTE_FAILED_TEXT });
  expect(await addCustomerNote(context, 'c1', 'Oat milk')).toEqual({ error: CUSTOMER_NOTE_FAILED_TEXT });
  expect(await addCustomerNote(context, 'c1', 'Oat milk')).toEqual({ error: CUSTOMER_NOTE_FAILED_TEXT });
});
