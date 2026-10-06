import { TAX_ROUNDING_MIXED_NOTE, type Closure } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { zReportLines } from './z-report';

// A closure as writeClosure freezes it: a float of 100.00, a cash and a card sale of 9.52 at 19 %, a paid out of 5.00,
// and the cash counted exactly.
const closure: Closure = {
  id: 'session-1', session_id: 'session-1', register_id: 'drawer-1', store_key: 'vendurepos_orders_0000abcd', number: 3,
  opened_at: '2026-09-30T07:00:00.000Z', business_day: '2026-09-30', closed_by: 'cashier@example.com',
  closed_at: '2026-09-30T17:00:00.000Z',
  till_expected: { cash: 10452, external: 952 }, expected: { cash: 10452, external: 952 }, counted: { cash: 10452 },
  variance: { cash: 0 }, period_sales_total_minor: 1904, period_refunds_total_minor: 0, perpetual_sales_total_minor: 1904,
  perpetual_refunds_total_minor: 0, unsynced_count: 0, unsynced_total_minor: 0, software_version: '0.1.0', printed_at: null,
  print_count: 0, order_ids: ['order-1', 'order-2'], movement_ids: ['movement-1'],
  breakdowns: {
    payment_methods: { cash: { sales_minor: 952, refunds_minor: 0 }, external: { sales_minor: 952, refunds_minor: 0 } },
    tax_rates: { 190000: { name: 'Tax 19%', net_minor: 1600, tax_minor: 304, gross_minor: 1904 } },
    opening_float: { expected_minor: null, counted_minor: 10000, variance_minor: null },
    movements: [{ id: 'movement-1', type: 'paid_out', amountMinor: 500, reason: 'Milk', voids: null,
      created_at_gmt: '2026-09-30T09:00:00.000Z', created_by: 'cashier@example.com', voided_by: null }],
    transaction_count: 2,
  },
} as Closure;

const context = { store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', printedAt: '2026-09-30T17:01:00.000Z' };

it("prints the closure document's own figures", () => {
  expect(zReportLines(closure, context)).toEqual([
    'Z report · Closure #3', 'http://127.0.0.1:3200', 'Opened Sep 30, 2026, 07:00', 'Closed Sep 30, 2026, 17:00',
    'Sales 2', 'Sales total €19.04', 'Opening float €100.00', 'Cash sales €9.52', 'Card sales €9.52',
    'Tax 19%: net €16.00, tax €3.04, gross €19.04', 'Paid out €5.00 Milk',
    'Cash expected €104.52', 'Cash counted €104.52', 'Cash variance €0.00', 'Card expected €9.52',
  ]);
});

it("notes the closure's orders still syncing when it was written, and nothing when there are none", () => {
  expect(zReportLines({ ...closure, unsynced_count: 2, unsynced_total_minor: 1904 }, context).at(-1)).toBe('2 orders still syncing');
  expect(zReportLines({ ...closure, unsynced_count: 1 }, context).at(-1)).toBe('1 order still syncing');
  expect(zReportLines(closure, context).join('\n')).not.toContain('syncing');
});

it('prints the mixed tax rounding note when the sales used more than one rounding (TallyUI #318)', () => {
  const mixed = { ...closure, breakdowns: { ...closure.breakdowns, tax_rounding_mixed: true } };
  expect(zReportLines(mixed, context).at(-1)).toBe(TAX_ROUNDING_MIXED_NOTE);
  expect(TAX_ROUNDING_MIXED_NOTE)
    .toBe("This register's sales used more than one tax rounding method. Each sale's tax is as its receipt showed.");
  expect(zReportLines(closure, context)).not.toContain(TAX_ROUNDING_MIXED_NOTE);
});

it('prints a typed approver when the closure carries one', () => {
  const approved = { ...closure, breakdowns: { ...closure.breakdowns, approved_by_name: 'Sam (typed)' } };
  expect(zReportLines(approved, context)).toContain('Approved by Sam (typed)');
  expect(zReportLines(closure, context).some((line) => line.startsWith('Approved by '))).toBe(false);
});
