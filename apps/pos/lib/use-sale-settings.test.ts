import type { ServerCapabilities, TallyConnector } from '@tallyui/core';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './session';
import { fetchTaxRateCodes } from './tax-rate-codes';
// Renamed so the hook can run outside a component here, where React's hooks are mocked.
import { READ_TIMEOUT_MS, retryDelayMs, useSaleSettings as saleSettingsHook, type SaleSettingsState } from './use-sale-settings';

vi.mock('react', async (importActual) => ({
  ...await importActual<typeof import('react')>(),
  useEffect: vi.fn(), useState: vi.fn(),
}));
vi.mock('./tax-rate-codes', () => ({ fetchTaxRateCodes: vi.fn() }));

const session: Session = {
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'test-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};
// The dev store's /info (vendurepos #60).
const storeCapabilities: ServerCapabilities = { orderCreate: 1, taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' } };
const names = { '1': 'Standard DE 19%', default: 'Standard DE 19%' };

let states: SaleSettingsState[];
let cleanup: (() => void) | void;

function mount(connector: Partial<TallyConnector>) {
  saleSettingsHook(session, connector as TallyConnector);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  states = [];
  vi.mocked(useState).mockImplementation(((initial: SaleSettingsState) => [initial, (next: SaleSettingsState) => { states.push(next); }]) as any);
  vi.mocked(useEffect).mockImplementation((effect) => { cleanup = effect(); });
  vi.mocked(fetchTaxRateCodes).mockResolvedValue(names);
});

afterEach(() => {
  (cleanup as (() => void) | undefined)?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ready = () => states.filter((state) => state.status === 'ready');

describe('useSaleSettings', () => {
  it.each([
    ['rejects', () => Promise.reject(new Error('Failed to fetch'))],
    ['comes back inconclusive', () => Promise.resolve(undefined)],
  ])('waits and retries when the capabilities read %s, never readying on the default rounding', async (_, fail) => {
    const capabilities = vi.fn().mockImplementationOnce(fail).mockResolvedValue(storeCapabilities);
    mount({ capabilities });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toMatchObject([{ status: 'resolving', attempt: 1 }, { status: 'retrying', attempt: 1 }]);
    expect(ready()).toEqual([]);
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect(ready()).toEqual([{
      status: 'ready', settings: { ...session.settings, taxRounding: storeCapabilities.taxRounding }, rateCodes: names, capabilities: storeCapabilities,
    }]);
    // The names read succeeded the first time and is not repeated; once ready, nothing is read again.
    expect(fetchTaxRateCodes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect(states.at(-1)!.status).toBe('ready');
  });

  it('waits and retries when the rate-names read fails', async () => {
    const capabilities = vi.fn().mockResolvedValue(storeCapabilities);
    vi.mocked(fetchTaxRateCodes).mockRejectedValueOnce(new Error('HTTP 502'));
    mount({ capabilities });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ status: 'retrying', attempt: 1, lastError: new Error('HTTP 502') });
    expect(ready()).toEqual([]);
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(fetchTaxRateCodes).toHaveBeenCalledTimes(2);
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(ready()).toMatchObject([{ settings: { taxRounding: storeCapabilities.taxRounding }, rateCodes: names }]);
  });

  it('readies with no names when the names read succeeds empty', async () => {
    vi.mocked(fetchTaxRateCodes).mockResolvedValue({});
    mount({ capabilities: vi.fn().mockResolvedValue(storeCapabilities) });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ status: 'ready', rateCodes: {} });
  });

  it('gives the default rounding only to a connector that declares no capabilities read', async () => {
    mount({});
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ status: 'ready', settings: session.settings, rateCodes: names, capabilities: undefined });
  });

  it('times out a hung read and retries it', async () => {
    let firstSignal: AbortSignal | undefined;
    const capabilities = vi.fn()
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => { firstSignal = signal; return new Promise(() => {}); })
      .mockResolvedValue(storeCapabilities);
    mount({ capabilities });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(states).toMatchObject([{ status: 'resolving' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(firstSignal!.aborted).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: 'retrying', attempt: 1 });
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toMatchObject({ status: 'ready', settings: { taxRounding: storeCapabilities.taxRounding } });
  });

  it('backs off 1 s, 2 s, 4 s … capped at 30 s, and stops at unmount', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs)).toEqual([1, 2, 4, 8, 16, 30, 30, 30].map((s) => s * 1000));
    const capabilities = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    mount({ capabilities });
    await vi.advanceTimersByTimeAsync(0);
    for (const [attempt, seconds] of [[1, 1], [2, 2], [3, 4], [4, 8], [5, 16], [6, 30], [7, 30]]) {
      expect(capabilities).toHaveBeenCalledTimes(attempt);
      expect(states.at(-1)).toMatchObject({ status: 'retrying', attempt });
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(capabilities).toHaveBeenCalledTimes(attempt);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(capabilities).toHaveBeenCalledTimes(8);
    (cleanup as () => void)();
    cleanup = undefined;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(capabilities).toHaveBeenCalledTimes(8);
    expect(ready()).toEqual([]);
  });
});
