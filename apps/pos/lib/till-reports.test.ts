import { describe, expect, it } from 'vitest';
import type { SalesFilters } from '@tallyui/components';
import { presetRange, type PosOrder, type PosRefund, type ReportOrder } from '@tallyui/pos';
import { cashierSalesToday, compareLabel, hourlyGross, initialSalesFilters, reportOptions, tillHourly, tillOrderSpread, tillSalesFigures } from './till-reports';

const timezone = 'Europe/Madrid';
const today = '2026-11-16T12:00:00.000Z';
const filters = initialSalesFilters(new Date(today), timezone);
const order = (id: string, overrides: Partial<PosOrder> = {}) => ({
  id, createdAt: today, syncStatus: 'applied', cashierRef: 'cashier-a', registerId: 'register-a',
  totalMinor: 952, taxMinor: 152, discountMinor: 0, lines: [], payments: [], taxByRate: [], ...overrides,
}) as unknown as PosOrder;
const refund = (id: string, orderId: string, overrides: Partial<PosRefund> = {}) => ({
  id, orderId, createdAt: today, status: 'applied', registerId: 'register-a',
  envelope: { payload: { createdAt: today, totalMinor: 100 } }, ...overrides,
}) as unknown as PosRefund;
const figures = (orders: PosOrder[], refunds: PosRefund[] = [], selected: Partial<SalesFilters> = {}) =>
  tillSalesFigures({ orders, refunds, filters: { ...filters, ...selected }, timezone });

describe('tillSalesFigures', () => {
  it('counts pending and applied orders today, but excludes rejected orders', () => {
    const orders = [order('pending', { syncStatus: 'pending' }), order('applied'), order('rejected', { syncStatus: 'rejected' })];
    expect(figures(orders).totals.orderCount).toBe(2);
    expect(figures(orders, [], { cashierId: '', registerId: '' }).totals.orderCount).toBe(2);
  });

  it('keeps only orders and their refunds matching the applied or pending status', () => {
    const orders = [order('pending', { syncStatus: 'pending', totalMinor: 500 }), order('applied')];
    const refunds = [refund('pending-sale', 'pending'), refund('applied-sale', 'applied'), refund('unknown-sale', 'unknown')];
    const synced = figures(orders, refunds, { status: 'applied' });
    const waiting = figures(orders, refunds, { status: 'pending' });
    expect(synced.totals.orderCount).toBe(1);
    expect(synced.totals.grossMinor).toBe(952);
    expect(waiting.totals.orderCount).toBe(1);
    expect(waiting.totals.grossMinor).toBe(500);
    expect(synced.refunds.count).toBe(1);
    expect(waiting.refunds.count).toBe(1);
  });

  it('keeps the selected cashier’s orders and excludes refunds of another cashier’s orders', () => {
    const orders = [order('a'), order('b', { cashierRef: 'cashier-b' })];
    const refunds = [refund('a-refund', 'a'), refund('b-refund', 'b')];
    const result = figures(orders, refunds, { cashierId: 'cashier-a' });
    expect(result.totals.orderCount).toBe(1);
    expect(result.refunds.count).toBe(1);
  });

  it('keeps only the selected register’s orders and refunds', () => {
    const orders = [order('a'), order('b', { registerId: 'register-b' })];
    const refunds = [refund('a-refund', 'unknown'), refund('b-refund', 'a', { registerId: 'register-b' })];
    const result = figures(orders, refunds, { registerId: 'register-a' });
    expect(result.totals.orderCount).toBe(1);
    expect(result.refunds.count).toBe(1);
  });

  it('counts only applied refunds, with a pending refund of a kept order adding nothing', () => {
    const refunds = [refund('applied', 'a'), refund('pending', 'a', { status: 'pending' })];
    expect(figures([order('a')], refunds).refunds.count).toBe(1);
  });

  it('leaves yesterday outside today but includes it in the comparison range', () => {
    const result = figures([order('yesterday', { createdAt: '2026-11-15T12:00:00.000Z' })]);
    expect(result.totals.orderCount).toBe(0);
    expect(result.comparison?.totals.orderCount).toBe(1);
  });
});

describe('cashierSalesToday', () => {
  it('counts only the picked cashier’s sales today, excluding rejected orders', () => {
    const orders = [
      order('mine'), order('mine-2', { totalMinor: 500 }), order('theirs', { cashierRef: 'cashier-b' }),
      order('yesterday', { createdAt: '2026-11-15T12:00:00.000Z' }), order('rejected', { syncStatus: 'rejected' }),
    ];
    expect(cashierSalesToday({ orders, refunds: [], cashierRef: 'cashier-a', now: new Date(today), timezone })).toBe(1452);
    expect(cashierSalesToday({ orders, refunds: [], cashierRef: 'cashier-b', now: new Date(today), timezone })).toBe(952);
  });
});

describe('tillOrderSpread', () => {
  const spreadOf = (orders: PosOrder[]) => tillOrderSpread({ orders, filters, timezone });
  const totals = (...minors: number[]) => minors.map((totalMinor, i) => order(`o${i}`, { totalMinor }));

  it('takes the middle total for an odd count, and the largest', () => {
    expect(spreadOf(totals(2000, 500, 952)).current).toEqual({ medianMinor: 952, largestMinor: 2000 });
  });

  it('averages the two middle totals for an even count', () => {
    expect(spreadOf(totals(2000, 100, 500, 300)).current).toEqual({ medianMinor: 400, largestMinor: 2000 });
  });

  it('rounds the even-count median', () => {
    expect(spreadOf(totals(101, 200)).current.medianMinor).toBe(151);
  });

  it('leaves rejected orders and other days out of current, and puts yesterday in the comparison', () => {
    const result = spreadOf([
      ...totals(500, 952),
      order('rejected', { syncStatus: 'rejected', totalMinor: 9999 }),
      order('yesterday', { createdAt: '2026-11-15T12:00:00.000Z', totalMinor: 5000 }),
    ]);
    expect(result.current).toEqual({ medianMinor: 726, largestMinor: 952 });
    expect(result.comparison).toEqual({ medianMinor: 5000, largestMinor: 5000 });
  });

  it('gives zeros and no comparison with no orders', () => {
    expect(spreadOf([])).toEqual({ current: { medianMinor: 0, largestMinor: 0 }, comparison: undefined });
  });
});

it('lists distinct sorted cashiers and registers after All, excluding rejected orders and empty references', () => {
  expect(reportOptions([
    order('b', { cashierRef: 'cashier-b', registerId: 'register-b' }), order('a'), order('duplicate'),
    order('blank', { cashierRef: '', registerId: '' }), order('missing', { cashierRef: undefined, registerId: undefined }),
    order('rejected', { syncStatus: 'rejected', cashierRef: 'cashier-c', registerId: 'register-c' }),
  ])).toEqual({
    cashierOptions: [{ value: '', label: 'All' }, { value: 'cashier-a', label: 'cashier-a' }, { value: 'cashier-b', label: 'cashier-b' }],
    registerOptions: [{ value: '', label: 'All' }, { value: 'register-a', label: 'register-a' }, { value: 'register-b', label: 'register-b' }],
  });
});

it('initialises today in the given timezone, comparing previous, with all statuses and no cashier or register', () => {
  expect(initialSalesFilters(new Date('2026-11-16T00:30:00.000Z'), 'America/New_York')).toEqual({
    preset: 'today', range: { from: '2026-11-15', to: '2026-11-15' }, compare: 'previous', status: 'all', cashierId: null, registerId: null,
  });
});

it('hourlyGross sums same-hour gross into 24 buckets and excludes other days', () => {
  const orders = [
    { at: '2026-11-16T15:30:00Z', totalMinor: 952 },
    { at: '2026-11-16T15:10:00Z', totalMinor: 100 },
    { at: '2026-11-17T15:30:00Z', totalMinor: 952 },
  ] as unknown as ReportOrder[];
  const hours = hourlyGross(orders, '2026-11-16', 'America/New_York');
  expect(hours).toHaveLength(24);
  expect(hours[10]).toBe(1052);
  expect(hours.reduce((sum, gross) => sum + gross, 0)).toBe(1052);
});

it('hourlyGross takes the hour from the requested timezone', () => {
  const orders = [{ at: '2026-11-16T15:30:00Z', totalMinor: 952 }] as unknown as ReportOrder[];
  expect(hourlyGross(orders, '2026-11-16', 'Europe/Berlin')[16]).toBe(952);
});

it('tillHourly separates today and yesterday and excludes rejected orders from the gross', () => {
  const timezone = 'America/New_York';
  const selected = { ...filters, range: presetRange('today', new Date(today), timezone) };
  const orders = [
    order('today', { createdAt: '2026-11-16T15:30:00Z' }),
    order('yesterday', { createdAt: '2026-11-15T14:30:00Z' }),
    order('rejected', { createdAt: '2026-11-16T15:10:00Z', syncStatus: 'rejected' }),
  ];
  const result = tillHourly({ orders, filters: selected, timezone })!;
  expect(result.hours[10]).toBe(952);
  expect(result.compareHours[9]).toBe(952);
  expect(result.hours[9]).toBe(0);
  expect(result.hours.reduce((sum, gross) => sum + gross, 0)).toBe(tillSalesFigures({ orders, refunds: [], filters: selected, timezone }).totals.grossMinor);
});

it('tillHourly returns null for thisWeek even when its range is one day', () => {
  const selected: SalesFilters = { ...filters, preset: 'thisWeek', range: presetRange('thisWeek', new Date(today), timezone) };
  expect(tillHourly({ orders: [order('today')], filters: selected, timezone })).toBeNull();
});

it('compareLabel names yesterday, last weekday, the week before and the month before', () => {
  const selected = { ...filters, range: presetRange('today', new Date(today), timezone) };
  expect(compareLabel(selected)).toBe('vs yesterday');
  expect(compareLabel({ ...selected, compare: 'week' })).toBe('vs last Monday');
  expect(compareLabel({ ...selected, preset: 'thisWeek', range: presetRange('thisWeek', new Date(today), timezone) })).toBe('vs the week before');
  expect(compareLabel({ ...selected, preset: 'thisMonth', range: presetRange('thisMonth', new Date(today), timezone) })).toBe('vs the month before');
});
