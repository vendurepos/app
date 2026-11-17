import type { RegisterSession } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { handoverSlipLines } from './handover-slip';

const session = {
  id: 'session-1', register_id: 'drawer-1', store_key: 'vendurepos_orders_0000abcd', status: 'open',
  business_day: '2026-09-30', opened_at_gmt: '2026-09-30T07:00:00.000Z', opened_by: 'cashier@example.com',
  expected_float_minor: null, counted_float_minor: 10000, opening_variance_minor: null,
} as RegisterSession;
const outbox = { sales: { pending: 0, rejected: 0, stuck: 0 }, tillUpdates: { pending: 0, rejected: 0, stuck: 0 } };
const context = {
  store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', printedAt: '2026-09-30T12:00:00.000Z', cashier: 'cashier@example.com', outbox,
};
const register = { session, expected: { cash: 10452, external: 952 }, salesCount: 2, blind: false };

it('prints the hand-over slip naming the cashier and the expected tenders', () => {
  expect(handoverSlipLines(register, context)).toEqual([
    'Hand-over slip', 'http://127.0.0.1:3200', 'Register · open since 07:00 · cashier@example.com', 'Printed Sep 30, 2026, 12:00',
    'Handed over by cashier@example.com', '2 sales', 'Expected Cash €104.52', 'Expected Card €9.52',
  ]);
});

it('omits expected figures while blind and prints unsent sales and till updates', () => {
  expect(handoverSlipLines({ ...register, salesCount: 1, blind: true }, {
    ...context, outbox: { sales: { ...outbox.sales, pending: 1 }, tillUpdates: { ...outbox.tillUpdates, pending: 2 } },
  })).toEqual([
    'Hand-over slip', 'http://127.0.0.1:3200', 'Register · open since 07:00 · cashier@example.com', 'Printed Sep 30, 2026, 12:00',
    'Handed over by cashier@example.com', '1 sale', '1 unsent sale', '2 unsent till updates',
  ]);
});
