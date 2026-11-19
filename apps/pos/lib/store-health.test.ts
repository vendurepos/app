import { describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '@tallyui/core';
import type { PosOrder } from '@tallyui/pos';
import { attentionReason, attentionRows, canSendAgain, changesWaiting, confirmRedownload, coveragePercent, readServerTotals, readyToSell, recordsOnDevice, redownloadBlocked, redownloadSummary } from './store-health';

it("words Clear & re-download's confirm for no product, one and several", () => {
  expect(redownloadSummary(0)).toBe('No products are on this device yet; they download again from your store.');
  expect(redownloadSummary(1)).toBe('1 product is removed from this device and downloaded again from your store.');
  expect(redownloadSummary(3)).toBe('3 products are removed from this device and downloaded again from your store.');
});

it.each([
  [true, 5, 'Re-downloading…'],
  [false, null, 'Needs your store to answer, so the products can download again.'],
  [false, 0, null],
  [false, 5, null],
] as const)('blocks Clear & re-download (redownloading %s, server products %s) with %s', (redownloading, serverProducts, reason) => {
  expect(redownloadBlocked(redownloading, serverProducts)).toBe(reason);
});

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

it('gives coverage as on device over on server, capped at 100, and null when a figure is unknown', () => {
  expect([[30, 30], [0, 3], [1, 3], [5, 3], [0, 0]].map(([device, server]) => coveragePercent(device, server))).toEqual([100, 0, 33, 100, 100]);
  expect(coveragePercent(null, 3)).toBeNull();
  expect(coveragePercent(3, null)).toBeNull();
});

it('reads no server totals while offline', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  try {
    expect(await readServerTotals({ connectorId: 'vendure', baseUrl: 'https://store.invalid', headers: {} } as SyncContext))
      .toEqual({ products: null, orders: null });
  } finally { vi.unstubAllGlobals(); }
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

describe('attentionReason and canSendAgain', () => {
  const sale = { id: 'sale', saleId: 'sale', createdAt: '2026-11-17T10:00:00Z', commandId: 'cmd-sale' } as PosOrder;
  it.each([
    [{ syncStatus: 'rejected', error: { code: 'invalid_payload' } }, 'Refused by the store — invalid_payload', true],
    [{ syncStatus: 'rejected', error: { code: 'idempotency_mismatch' } }, 'Refused by the store — idempotency_mismatch', false],
    [{ syncStatus: 'pending' }, "Can't reach the store", false],
  ] as const)('words %o as attentionRows did', (fields, reason, retry) => {
    const order = { ...sale, ...fields } as PosOrder;
    expect([attentionReason(order), canSendAgain(order)]).toEqual([reason, retry]);
  });
});

it('refuses to clear on Yes when the store no longer answers', async () => {
  const totals = { products: null, orders: null };
  const onTotals = vi.fn();
  const onRedownload = vi.fn(async () => {});
  expect(await confirmRedownload(async () => totals, onTotals, onRedownload)).toBe('refused');
  expect(onTotals).toHaveBeenCalledWith(totals);
  expect(onRedownload).not.toHaveBeenCalled();
});

it('clears on Yes when the store answers', async () => {
  const onRedownload = vi.fn(async () => {});
  expect(await confirmRedownload(async () => ({ products: 5, orders: 2 }), vi.fn(), onRedownload)).toBe('cleared');
  expect(onRedownload).toHaveBeenCalledTimes(1);
});
