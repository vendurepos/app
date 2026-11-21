import type { SyncContext } from '@tallyui/core';
import { afterEach, expect, it, vi } from 'vitest';
import { listOrderNotes, ORDER_NOTES_QUERY, ORDER_NOTE_OPTIONS, toOrderNotes } from './order-notes';

const context: SyncContext = {
  connectorId: 'vendure', baseUrl: 'https://shop.example.com',
  headers: { Authorization: 'Bearer test-token' }, signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());

it('toOrderNotes keeps order, maps public and staff notes, trims text and drops missing, non-string or blank notes', () => {
  expect(toOrderNotes([
    { id: '2', isPublic: true, data: { note: '  Public note  ' } },
    { id: 'missing', isPublic: true, data: {} },
    { id: 'number', isPublic: true, data: { note: 12 } },
    { id: 'blank', isPublic: false, data: { note: ' \n ' } },
    { id: '1', isPublic: false, data: { note: ' Staff note\n' } },
  ])).toEqual([{ id: '2', text: 'Public note', staff: false }, { id: '1', text: 'Staff note', staff: true }]);
});

it('listOrderNotes POSTs the notes query and options, maps the answer and returns no notes for an absent order', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { order: { id: '2', history: { items: [
    { id: 'h2', isPublic: true, data: { note: ' Public note ' } },
    { id: 'h3', isPublic: false, data: { note: ' Staff note ' } },
  ] } } } })).mockResolvedValueOnce(Response.json({ data: { order: null } }));
  vi.stubGlobal('fetch', fetch);
  expect(await listOrderNotes(context, '2')).toEqual([
    { id: 'h2', text: 'Public note', staff: false }, { id: 'h3', text: 'Staff note', staff: true },
  ]);
  expect(ORDER_NOTE_OPTIONS.filter).toEqual({ type: { eq: 'ORDER_NOTE' } });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers }, signal: context.signal,
    body: JSON.stringify({ query: ORDER_NOTES_QUERY, variables: { id: '2', options: ORDER_NOTE_OPTIONS } }),
  });
  expect(await listOrderNotes(context, '2')).toEqual([]);
});

it('listOrderNotes rejects GraphQL errors and HTTP 403', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Forbidden' }] }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 })));
  await expect(listOrderNotes(context, '2')).rejects.toThrow('Forbidden');
  await expect(listOrderNotes(context, '2')).rejects.toThrow('HTTP 403');
});
