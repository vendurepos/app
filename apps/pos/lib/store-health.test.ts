import { describe, expect, it } from 'vitest';
import type { PosOrder } from '@tallyui/pos';
import { attentionRows, changesWaiting, readyToSell, recordsOnDevice } from './store-health';

describe('readyToSell', () => {
  const ready = { catalogueSynced: true, signedOut: false, settingsReady: true, ordersOpen: true };
  it('is ready when all four facts are good', () => {
    expect(readyToSell(ready)).toEqual({ ready: true });
  });
  it.each([
    [{ signedOut: true }, 'The store refused this sign-in'],
    [{ catalogueSynced: false }, 'The catalogue has not synced yet'],
    [{ settingsReady: false }, "The store's settings are not read yet"],
    [{ ordersOpen: false }, 'The order store is not open yet'],
  ] as const)('reports the reason for %o', (fact, reason) => {
    expect(readyToSell({ ...ready, ...fact })).toEqual({ ready: false, reason });
  });
  it('reports refused sign-in before an unsynced catalogue', () => {
    expect(readyToSell({ ...ready, signedOut: true, catalogueSynced: false })).toEqual({ ready: false, reason: 'The store refused this sign-in' });
  });
});

it('counts pending sales and till updates', () => {
  expect(changesWaiting({ pending: 2, sending: false }, { pending: 1, sending: false })).toBe(3);
  expect(changesWaiting({ pending: 0, sending: false }, { pending: 0, sending: false })).toBe(0);
});

it('sums records with unread counts as zero', () => {
  expect(recordsOnDevice([3, null, 2])).toBe(5);
  expect(recordsOnDevice([])).toBe(0);
});

describe('attentionRows', () => {
  it('offers Retry for a refused sale with a requeueable code', () => {
    const order = { id: 'rejected', saleId: 'rejected', createdAt: '2026-11-17T10:00:00Z', commandId: 'cmd-rejected',
      syncStatus: 'rejected', error: { code: 'platform_error' } } as PosOrder;
    expect(attentionRows([order], undefined)).toEqual([{ order, reason: 'Refused by the store — platform_error', retry: true }]);
  });

  it('does not offer Retry for an idempotency mismatch', () => {
    const order = { id: 'rejected', saleId: 'rejected', createdAt: '2026-11-17T10:00:00Z', commandId: 'cmd-rejected',
      syncStatus: 'rejected', error: { code: 'idempotency_mismatch' } } as PosOrder;
    expect(attentionRows([order], undefined)).toEqual([{ order, reason: 'Refused by the store — idempotency_mismatch', retry: false }]);
  });

  it('shows the stuck reason for a pending order without Retry', () => {
    const order = { id: 'pending', saleId: 'pending', createdAt: '2026-11-17T11:00:00Z', commandId: 'cmd-pending', syncStatus: 'pending' } as PosOrder;
    const stuck = { commandIds: ['cmd-pending'], since: 1, reason: 'HTTP 500', orders: [{ commandId: 'cmd-pending', since: 1, reason: 'HTTP 500' }] };
    expect(attentionRows([order], stuck)).toEqual([{ order, reason: "Can't reach the store — HTTP 500", retry: false }]);
  });

  it('omits pending orders that are not stuck and applied orders without warnings', () => {
    const pending = { id: 'pending', saleId: 'pending', createdAt: '2026-11-17T11:00:00Z', commandId: 'cmd-pending', syncStatus: 'pending' } as PosOrder;
    const applied = { id: 'applied', saleId: 'applied', createdAt: '2026-11-17T10:00:00Z', commandId: 'cmd-applied', syncStatus: 'applied' } as PosOrder;
    expect(attentionRows([pending, applied], undefined)).toEqual([]);
  });

  it('shows an applied sale taken after the register closed without Retry', () => {
    const order = { id: 'late', saleId: 'late', createdAt: '2026-11-17T10:00:00Z', commandId: 'cmd-late',
      syncStatus: 'applied', lateSessionId: 's1' } as PosOrder;
    expect(attentionRows([order], undefined)).toEqual([{ order, reason: 'Taken after the register closed', retry: false }]);
  });

  it('keeps the newest-first order from needsAttention', () => {
    const rejected = { id: 'rejected', saleId: 'rejected', createdAt: '2026-11-17T10:00:00Z', commandId: 'cmd-rejected', syncStatus: 'rejected' } as PosOrder;
    const pending = { id: 'pending', saleId: 'pending', createdAt: '2026-11-17T11:00:00Z', commandId: 'cmd-pending', syncStatus: 'pending' } as PosOrder;
    const stuck = { commandIds: ['cmd-pending'], since: 1, reason: 'HTTP 500', orders: [{ commandId: 'cmd-pending', since: 1, reason: 'HTTP 500' }] };
    expect(attentionRows([rejected, pending], stuck).map(row => row.order)).toEqual([pending, rejected]);
  });

  it('returns no rows for no orders', () => {
    expect(attentionRows([], undefined)).toEqual([]);
  });
});
