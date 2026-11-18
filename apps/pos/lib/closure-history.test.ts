import { formatMoney } from '@tallyui/core';
import type { Closure } from '@tallyui/pos';
import { expect, it } from 'vitest';
import {
  closureCsvFileName, closureFromRead, closureHistoryCsv, closureHistoryRows, closureSummary, mergeClosures, openSessionRows, zCopyLines,
  type TallyClosureRead,
} from './closure-history';
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
  ownRegisterId: 'drawer-1', names: {}, storeKey: 'vendurepos_orders_0000abcd', currency: 'EUR', timezone: 'UTC', today: '2026-09-30', blind: false,
};

it("lists this till's closures newest first", () => {
  const previous = {
    ...closure, id: 'session-2', number: 2, business_day: '2026-09-29', opened_at: '2026-09-29T07:00:00.000Z',
    closed_at: '2026-09-29T17:00:00.000Z', variance: { cash: -500 }, period_sales_total_minor: 0,
  };
  expect(closureHistoryRows([previous, { ...closure, id: 'other-store', store_key: 'vendurepos_orders_ffff0000' }, closure], options)).toEqual([
    { id: 'session-1', registerId: 'drawer-1', register: 'This device', number: 3, closedAt: 'Sep 30, 2026, 17:00', salesTotal: '€19.04',
      cashAtOpen: '€100.00', cashAtClose: '€104.52', variance: 'Exact', expected: '€104.52', day: '2026-09-30', dayLabel: 'Today' },
    { id: 'session-2', registerId: 'drawer-1', register: 'This device', number: 2, closedAt: 'Sep 29, 2026, 17:00', salesTotal: '€0.00',
      cashAtOpen: '€100.00', cashAtClose: '€104.52', variance: '€5.00 short', expected: '€104.52', day: '2026-09-29', dayLabel: 'Yesterday' },
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
    { id: 'session-1', registerId: 'drawer-1', register: 'This device', number: 3, closedAt: 'Sep 30, 2026, 17:00', salesTotal: '', cashAtOpen: '',
      cashAtClose: '', variance: '', expected: '', day: '2026-09-30', dayLabel: 'Today' },
  ]);
});

it('leaves out a missing cash at open and close', () => {
  const { opening_float: _float, ...breakdowns } = closure.breakdowns;
  expect(closureHistoryRows([{ ...closure, counted: {}, breakdowns } as Closure], options)[0])
    .toMatchObject({ cashAtOpen: '', cashAtClose: '' });
});

it("exports v2's closures CSV of this till's closures", () => {
  const lines = closureHistoryCsv([closure, { ...closure, id: 'other-store', store_key: 'vendurepos_orders_ffff0000' }], { ...options, store: 'Demo store' })
    .split('\r\n').filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe('"Business day","Closure","Register","Store","Opened","Closed","Closed by","Expected (cash)","Counted (cash)",'
    + '"Variance (cash)","Expected (external)","Counted (external)","Variance (external)","Status"');
  expect(lines[1].startsWith('"2026-09-30","3","This device","Demo store",')).toBe(true);
  expect(lines[1]).toContain('"104.52","104.52","0.00 Exact"');
});

it("names the closures CSV by the listed closures' dates", () => {
  expect(closureCsvFileName([], options)).toBe('closures-2026-09-30.csv');
  expect(closureCsvFileName([closure], options)).toBe('closures-2026-09-30-to-2026-09-30.csv');
  const older = {
    ...closure, id: 'session-1b', number: 1, business_day: '2026-09-01',
    opened_at: '2026-09-01T07:00:00.000Z', closed_at: '2026-09-01T17:00:00.000Z',
  };
  const middle = {
    ...closure, id: 'session-2', number: 2, business_day: '2026-09-29',
    opened_at: '2026-09-29T07:00:00.000Z', closed_at: '2026-09-29T17:00:00.000Z',
  };
  expect(closureCsvFileName([
    middle, closure, older, { ...older, id: 'other-store', store_key: 'vendurepos_orders_ffff0000', business_day: '2026-08-15',
      opened_at: '2026-08-15T07:00:00.000Z', closed_at: '2026-08-15T17:00:00.000Z' },
  ], options)).toBe('closures-2026-09-01-to-2026-09-30.csv');
  expect(closureCsvFileName([{ ...closure, closed_at: '2026-09-30T23:30:00.000Z' }], {
    ...options, timezone: 'Europe/Berlin', today: '2026-10-01',
  })).toBe('closures-2026-10-01-to-2026-10-01.csv');
});

it('marks a reprinted Z as a copy', () => {
  const context = { store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', printedAt: '2026-09-30T18:15:00.000Z' };
  expect(zCopyLines(closure, context)).toEqual([
    'Z report · Closure #3', 'Copy · printed Sep 30, 2026, 18:15', ...zReportLines(closure, context).slice(1),
  ]);
});

// Another register's closure as the plugin's GET /tally/v1/registers/:id reads it: no breakdowns, no business day.
const read: TallyClosureRead = {
  closureId: 'closure-9', sessionId: 'session-9', registerId: 'drawer-2', number: 1, businessDay: null,
  openedAt: '2026-09-30T08:00:00.000Z', closedAt: '2026-09-30T18:00:00.000Z', closedBy: null, approvedBy: null,
  tillExpected: { cash: 15000 }, counted: { cash: 15000 }, expected: { cash: 15000 }, variance: { cash: 0 },
  periodSalesTotalMinor: 24550, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 24550, perpetualRefundsTotalMinor: 0,
  unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '0.1.0', orderIds: ['order-9'], movementIds: [], receivedAt: '2026-09-30T18:00:01.000Z',
};
const remote = closureFromRead(read, options.storeKey);
const names = { 'drawer-2': 'Front counter' };

it("maps the plugin's closure read onto a Closure", () => {
  expect(remote).toEqual({
    id: 'closure-9', server_closure_id: 'closure-9', session_id: 'session-9', register_id: 'drawer-2', store_key: options.storeKey,
    business_day: '', closed_by: null, number: 1, opened_at: read.openedAt, closed_at: read.closedAt, till_expected: { cash: 15000 },
    expected: { cash: 15000 }, counted: { cash: 15000 }, variance: { cash: 0 }, period_sales_total_minor: 24550, period_refunds_total_minor: 0,
    perpetual_sales_total_minor: 24550, perpetual_refunds_total_minor: 0, unsynced_count: 0, unsynced_total_minor: 0, software_version: '0.1.0',
    breakdowns: {}, order_ids: ['order-9'], movement_ids: [], printed_at: null, print_count: 0, number_retried: false, corrections_count: 0,
  });
});

it("prints another register's Z copy without the lines its read lacks", () => {
  const context = { store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', printedAt: '2026-09-30T18:15:00.000Z' };
  const lines = zCopyLines(remote, context);
  expect(lines.filter((line) => line.includes('undefined') || line.startsWith('Opening float'))).toEqual([]);
  expect(lines).toEqual(expect.arrayContaining(['Sales total €245.50', 'Cash expected €150.00', 'Cash counted €150.00', 'Cash variance €0.00']));
});

it("keeps the local copy of a closure the server also has, and adds other registers' after the local ones", () => {
  const synced = { ...closure, id: 'session-5', server_closure_id: 'closure-5' };
  const merged = mergeClosures([closure, synced], [{ ...remote, id: 'session-1' }, { ...remote, id: 'closure-5' }, remote]);
  expect(merged.map((row) => row.id)).toEqual(['session-1', 'session-5', 'closure-9']);
  expect(merged[0]).toBe(closure);
});

it("lists every register's closures of this store, this device's and the others' by name", () => {
  const rows = closureHistoryRows([closure, remote, { ...remote, id: 'other-store', store_key: 'vendurepos_orders_ffff0000' }], { ...options, names });
  expect(rows.map(({ id, register }) => ({ id, register }))).toEqual([
    { id: 'closure-9', register: 'Front counter' }, { id: 'session-1', register: 'This device' },
  ]);
  expect(rows[0]).toMatchObject({ registerId: 'drawer-2', salesTotal: '€245.50', cashAtOpen: '', cashAtClose: '€150.00', variance: 'Exact' });
});

it("names another register in the closures CSV's Register column", () => {
  const lines = closureHistoryCsv([closure, remote], { ...options, names, store: 'Demo store' }).split('\r\n').filter(Boolean);
  expect(lines.slice(1).map((line) => line.split(',')[2])).toEqual(['"Front counter"', '"This device"']);
});

it("gives each register with a live session an open row, this device's as 'This device'", () => {
  const session = { openedAt: '2026-09-30T08:15:00.000Z', openedBy: null, deviceName: null };
  expect(openSessionRows([
    { id: 'drawer-1', receivedAt: '', lastDeviceName: 'Till 1', session: { ...session, status: 'open' } },
    { id: 'drawer-2', receivedAt: '', lastDeviceName: 'Front counter', session: { ...session, status: 'counting' } },
    { id: 'drawer-3', receivedAt: '', lastDeviceName: 'Back office', session: null },
  ], { ownRegisterId: 'drawer-1', timezone: 'UTC' })).toEqual([
    { registerId: 'drawer-1', register: 'This device', status: 'open', since: 'Sep 30, 2026, 08:15' },
    { registerId: 'drawer-2', register: 'Front counter', status: 'counting', since: 'Sep 30, 2026, 08:15' },
  ]);
});

it("sums the listed closures' cash variance and cash counted, and counts the open sessions with them", () => {
  const listed = [
    { ...closure, variance: { cash: -100 }, counted: { cash: 15000 } },
    { ...remote, variance: { cash: 0 }, counted: { cash: 10000 } },
    { ...remote, id: 'other-store', store_key: 'vendurepos_orders_ffff0000', variance: { cash: -900 }, counted: { cash: 90000 } },
  ];
  expect(closureSummary(listed, { ...options, open: 1 })).toEqual({
    sessions: '3', sessionsNote: '1 open · 2 closed', discrepancy: formatMoney({ amount: -100, currency: 'EUR' }), cashAtClose: '€250.00',
  });
  expect(closureSummary(listed, { ...options, open: 1, blind: true })).toMatchObject({ discrepancy: '—', cashAtClose: '—' });
  expect(closureSummary([], { ...options, open: 0 })).toMatchObject({ sessions: '0', discrepancy: '—', cashAtClose: '—' });
});
