import { describe, expect, it } from 'vitest';
import type { SalesFilters } from '@tallyui/components';
import type { PosOrder, PosRefund } from '@tallyui/pos';
import { initialSalesFilters, reportOptions, tillSalesFigures } from './till-reports';

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
