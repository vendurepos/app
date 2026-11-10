import type { Closure } from '@tallyui/pos';
import { expect, it } from 'vitest';
import { closureHistoryRows, zCopyLines } from './closure-history';
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

const options = {
  registerId: 'drawer-1', storeKey: 'vendurepos_orders_0000abcd', currency: 'EUR', timezone: 'UTC', today: '2026-09-30', blind: false,
};

it("lists this till's closures newest first", () => {
  const previous = {
    ...closure, id: 'session-2', number: 2, business_day: '2026-09-29', opened_at: '2026-09-29T07:00:00.000Z',
    closed_at: '2026-09-29T17:00:00.000Z', variance: { cash: -500 }, period_sales_total_minor: 0,
  };
  expect(closureHistoryRows([
    previous, { ...closure, id: 'other-register', register_id: 'drawer-2' },
    { ...closure, id: 'other-store', store_key: 'vendurepos_orders_ffff0000' }, closure,
  ], options)).toEqual([
    { id: 'session-1', number: 3, closedAt: 'Sep 30, 2026, 17:00', salesTotal: '€19.04', variance: 'Exact' },
    { id: 'session-2', number: 2, closedAt: 'Sep 29, 2026, 17:00', salesTotal: '€0.00', variance: '€5.00 short' },
  ]);
});

it('leaves out closures older than 92 days', () => {
  expect(closureHistoryRows([{ ...closure, business_day: '2026-05-01' }], options)).toEqual([]);
});

it('words an over and a missing cash variance', () => {
  expect(closureHistoryRows([{ ...closure, variance: { cash: 200 } }], options)[0].variance).toBe('€2.00 over');
  expect(closureHistoryRows([{ ...closure, variance: {} }], options)[0].variance).toBe('');
});

it('shows no figures while the count is blind', () => {
  expect(closureHistoryRows([closure], { ...options, blind: true })).toEqual([
    { id: 'session-1', number: 3, closedAt: 'Sep 30, 2026, 17:00', salesTotal: '', variance: '' },
  ]);
});

it('marks a reprinted Z as a copy', () => {
  const context = { store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', printedAt: '2026-09-30T18:15:00.000Z' };
  expect(zCopyLines(closure, context)).toEqual([
    'Z report · Closure #3', 'Copy · printed Sep 30, 2026, 18:15', ...zReportLines(closure, context).slice(1),
  ]);
});
