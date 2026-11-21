import { useEffect, useState } from 'react';
import type { SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';

export const ORDER_NOTES_QUERY = `query OrderNotes($id: ID!, $options: HistoryEntryListOptions) {
  order(id: $id) { id history(options: $options) { items { id isPublic data } } }
}`;
// Vendure keeps an order's notes as ORDER_NOTE history entries among its state changes; the sheet reads only the notes, oldest first.
export const ORDER_NOTE_OPTIONS = { take: 100, sort: { createdAt: 'ASC' }, filter: { type: { eq: 'ORDER_NOTE' } } };
export const NOTE_LABEL = 'Note';
// A private (isPublic: false) note, which Vendure never shows the customer (Front desk ruling, 2026-11-21).
export const STAFF_NOTE_LABEL = 'Staff note';

export type OrderNote = { id: string; text: string; staff: boolean };

/** History entries as notes: data.note trimmed; an entry without a non-empty string note is dropped; staff = !isPublic. Order kept. */
export function toOrderNotes(items: readonly { id: string; isPublic: boolean; data: unknown }[]): OrderNote[] {
  return items.flatMap(({ id, isPublic, data }) => {
    const note = data && typeof data === 'object' && 'note' in data ? data.note : undefined;
    const text = typeof note === 'string' ? note.trim() : '';
    return text ? [{ id, text, staff: !isPublic }] : [];
  });
}

/** One Admin API read of the order's notes; throws on HTTP or GraphQL errors; [] when the order is not found (order: null). */
export async function listOrderNotes(context: SyncContext, orderId: string): Promise<OrderNote[]> {
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal,
    body: JSON.stringify({ query: ORDER_NOTES_QUERY, variables: { id: orderId, options: ORDER_NOTE_OPTIONS } }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return toOrderNotes(body.data.order === null ? [] : body.data.order.history.items);
}

/** The order's notes: [] until the read answers, when orderId is null, and when the read fails or is refused (no new permission is asked). */
export function useOrderNotes(session: Session, orderId: string | null): OrderNote[] {
  const [notes, setNotes] = useState<OrderNote[]>([]);
  useEffect(() => {
    setNotes([]);
    if (orderId === null) return;
    let cancelled = false;
    void listOrderNotes(sessionContext(session), orderId).then(found => {
      if (!cancelled) setNotes(found);
    }, () => {});
    return () => { cancelled = true; };
  }, [session, orderId]);
  return notes;
}
