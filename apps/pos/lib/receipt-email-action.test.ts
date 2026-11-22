import { expect, it, vi } from 'vitest';
import { WALK_IN_EMAIL } from './customer-list';
import { receiptEmailDefault } from './receipt-email-action';

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
