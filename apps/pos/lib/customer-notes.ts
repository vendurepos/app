import { useCallback, useEffect, useState } from 'react';
import type { SyncContext } from '@tallyui/core';
import { toOrderNotes } from './order-notes';
import { sessionContext, type Session } from './session';

export const CUSTOMER_NOTES_QUERY = `query CustomerNotes($id: ID!, $options: HistoryEntryListOptions) {
  customer(id: $id) { id history(options: $options) { items { id isPublic data } } }
}`;
// Vendure keeps a customer's notes as CUSTOMER_NOTE history entries among its other events; the sheet reads only the notes, oldest first.
export const CUSTOMER_NOTE_OPTIONS = { take: 100, sort: { createdAt: 'ASC' }, filter: { type: { eq: 'CUSTOMER_NOTE' } } };
export const ADD_CUSTOMER_NOTE_MUTATION = `mutation AddCustomerNote($input: AddNoteToCustomerInput!) {
  addNoteToCustomer(input: $input) { id }
}`;
export const CUSTOMER_NOTE_FORBIDDEN_TEXT = "This till's role can't add notes to the store's customers. Ask the store's admin to add the Update customer permission.";
export const CUSTOMER_NOTE_FAILED_TEXT = "The store didn't save this note. Try again.";

export type CustomerNote = { id: string; text: string };

/** One Admin API read of the customer's notes; throws on HTTP or GraphQL errors; [] when the customer is not found (customer: null). */
export async function listCustomerNotes(context: SyncContext, customerId: string): Promise<CustomerNote[]> {
  const response = await fetch(`${context.baseUrl}/admin-api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal,
    body: JSON.stringify({ query: CUSTOMER_NOTES_QUERY, variables: { id: customerId, options: CUSTOMER_NOTE_OPTIONS } }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  if (body.data.customer === null) return [];
  return toOrderNotes(body.data.customer.history.items).map(({ id, text }) => ({ id, text }));
}

/** Adds one note to the customer; never throws. A blank note is refused without a request. */
export async function addCustomerNote(context: SyncContext, customerId: string, note: string): Promise<{ ok: true } | { error: string }> {
  const trimmed = note.trim();
  if (!trimmed) return { error: CUSTOMER_NOTE_FAILED_TEXT };
  try {
    const response = await fetch(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal,
      // Vendure shows customer notes only in the Admin API, so every one is a private staff note.
      body: JSON.stringify({ query: ADD_CUSTOMER_NOTE_MUTATION, variables: { input: { id: customerId, note: trimmed, isPublic: false } } }),
    });
    if (response.status === 403) return { error: CUSTOMER_NOTE_FORBIDDEN_TEXT };
    const body = await response.json();
    if (body.errors?.some((error: { extensions?: { code?: string } }) => error.extensions?.code === 'FORBIDDEN')) return { error: CUSTOMER_NOTE_FORBIDDEN_TEXT };
    return response.ok && body.data?.addNoteToCustomer ? { ok: true } : { error: CUSTOMER_NOTE_FAILED_TEXT };
  } catch {
    return { error: CUSTOMER_NOTE_FAILED_TEXT };
  }
}

/** The customer's notes: [] until the read answers, when customerId is null, and when the read fails or is refused; reload() reads again. */
export function useCustomerNotes(session: Session, customerId: string | null): { notes: CustomerNote[]; reload(): void } {
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    setNotes([]);
    if (customerId === null) return;
    let cancelled = false;
    void listCustomerNotes(sessionContext(session), customerId).then(found => {
      if (!cancelled) setNotes(found);
    }, () => {});
    return () => { cancelled = true; };
  }, [session, customerId, generation]);
  const reload = useCallback(() => setGeneration(current => current + 1), []);
  return { notes, reload };
}
