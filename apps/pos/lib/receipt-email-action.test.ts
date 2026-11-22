import { expect, it, vi } from 'vitest';
import { WALK_IN_EMAIL } from './customer-list';
import { receiptEmailDefault, storedOrderCode } from './receipt-email-action';

vi.mock('@tallyui/components', () => ({ Button: () => null, ReceiptEmailForm: () => null, Text: () => null, VStack: () => null }));

it.each([
  ['a customer email', { email: ' ann@example.com ' }, 'ann@example.com'],
  ['a Vendure emailAddress only', { emailAddress: 'bo@example.com' }, 'bo@example.com'],
  ['the walk-in by email', { email: WALK_IN_EMAIL }, undefined],
  ['the walk-in by emailAddress', { emailAddress: WALK_IN_EMAIL }, undefined],
  ['a blank email', { email: '  ' }, undefined],
  ['no customer', null, undefined],
])('prefills the email form for %s', (_name, customer, expected) => {
  expect(receiptEmailDefault(customer)).toBe(expected);
});

const refs = (displayId?: string) => ({ orderId: 'store-1', totalMinor: 952, ...(displayId === undefined ? {} : { displayId }) });
it.each([
  ['applied with a displayId', { syncStatus: 'applied' as const, serverRefs: refs('DEMO-000003') }, 'DEMO-000003'],
  ['pending with a displayId', { syncStatus: 'pending' as const, serverRefs: refs('DEMO-000003') }, null],
  ['rejected with a displayId', { syncStatus: 'rejected' as const, serverRefs: refs('DEMO-000003') }, null],
  ['applied without serverRefs', { syncStatus: 'applied' as const }, null],
  ['applied with an empty displayId', { syncStatus: 'applied' as const, serverRefs: refs('') }, null],
  ['no stored order', null, null],
])('gives the store code for %s', (_name, doc, expected) => {
  expect(storedOrderCode(doc)).toBe(expected);
});
