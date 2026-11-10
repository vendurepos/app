import type { CashMovement, RegisterSession } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { xReportLines } from './x-report';

const session = {
  id: 'session-1', register_id: 'drawer-1', store_key: 'vendurepos_orders_0000abcd', status: 'open',
  business_day: '2026-09-30', opened_at_gmt: '2026-09-30T07:00:00.000Z', opened_by: 'cashier@example.com',
  expected_float_minor: null, counted_float_minor: 10000, opening_variance_minor: null,
} as RegisterSession;
const movements: CashMovement[] = [
  { id: 'movement-1', session_id: 'session-1', type: 'paid_out', amountMinor: 500, reason: 'Milk',
    created_at_gmt: '2026-09-30T09:00:00.000Z', created_by: 'cashier@example.com', voids: null, voided_by: null },
  { id: 'movement-2', session_id: 'session-1', type: 'paid_in', amountMinor: 200, reason: 'Change',
    created_at_gmt: '2026-09-30T10:00:00.000Z', created_by: 'cashier@example.com', voids: null, voided_by: 'movement-3' },
  { id: 'movement-3', session_id: 'session-1', type: 'void', amountMinor: 200, reason: 'Change',
    created_at_gmt: '2026-09-30T11:00:00.000Z', created_by: 'cashier@example.com', voids: 'movement-2', voided_by: null },
];
const register = { session, expected: { cash: 10452, external: 952 }, movements, salesCount: 2, blind: false };
const context = { store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', printedAt: '2026-09-30T12:00:00.000Z' };

it("prints the open session's figures so far", () => {
  expect(xReportLines(register, context)).toEqual([
    'X report · Register open', 'http://127.0.0.1:3200', 'Opened Sep 30, 2026, 07:00', 'Printed Sep 30, 2026, 12:00',
    'Sales 2', 'Opening float €100.00', 'Paid out €5.00 Milk', 'Paid in €2.00 Change (voided)', 'Void €2.00 Change',
    'Cash expected €104.52', 'Card expected €9.52',
  ]);
});

it('prints no expected figures while the count is blind', () => {
  expect(xReportLines({ ...register, blind: true }, context)).toEqual([
    'X report · Register open', 'http://127.0.0.1:3200', 'Opened Sep 30, 2026, 07:00', 'Printed Sep 30, 2026, 12:00',
    'Sales 2', 'Opening float €100.00', 'Paid out €5.00 Milk', 'Paid in €2.00 Change (voided)', 'Void €2.00 Change',
  ]);
});

it('prints a session with no sales or movements', () => {
  expect(xReportLines({ ...register, movements: [], salesCount: 0, expected: { cash: 10000 } }, context)).toEqual([
    'X report · Register open', 'http://127.0.0.1:3200', 'Opened Sep 30, 2026, 07:00', 'Printed Sep 30, 2026, 12:00',
    'Sales 0', 'Opening float €100.00', 'Cash expected €100.00',
  ]);
});
