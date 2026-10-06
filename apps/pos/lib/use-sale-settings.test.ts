import type { ServerCapabilities, TallyConnector } from '@tallyui/core';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './session';
// Renamed so the hook can run outside a component here, where React's hooks are mocked.
import { MIN_ORDER_CREATE, MIN_REGISTER, READ_TIMEOUT_MS, readCapabilities, retryDelayMs, useSaleSettings as saleSettingsHook, type SaleSettingsState } from './use-sale-settings';

vi.mock('react', async (importActual) => ({
  ...await importActual<typeof import('react')>(),
  useEffect: vi.fn(), useRef: vi.fn(), useState: vi.fn(),
}));

const session: Session = {
  url: 'http://127.0.0.1:1', email: 'cashier@example.com', token: 'test-token',
  // Sign-in's settings carry the connector's rate names (TallyUI #334).
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 190000 }, taxRateCodes: { default: 'Standard DE 19%' } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};
// The dev store's /info (vendurepos #60), from the plugin this app ships with.
const storeCapabilities: ServerCapabilities = {
  orderCreate: 4, register: 1, taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
};

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
  vi.mocked(useRef).mockImplementation(((initial: unknown) => ({ current: initial })) as any);
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
      status: 'ready', settings: { ...session.settings, taxRounding: storeCapabilities.taxRounding }, capabilities: storeCapabilities,
    }]);
    // Once ready, nothing is read again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect(states.at(-1)!.status).toBe('ready');
  });

  it.each([
    ['no plugin (a 404 /info)', { orderCreate: 1 }],
    ['an older plugin', { orderCreate: 3, register: 1, taxRounding: storeCapabilities.taxRounding }],
    // A sale needs an open register session, synced to the plugin (vendurepos #79).
    ['a plugin without register commands', { orderCreate: 4, taxRounding: storeCapabilities.taxRounding }],
    ['a plugin at register 0', { orderCreate: 4, register: 0, taxRounding: storeCapabilities.taxRounding }],
  ])('never readies a store with %s, and shows the plugin notice across its retries', async (_, below) => {
    const capabilities = vi.fn().mockResolvedValue(below);
    mount({ capabilities });
    await vi.advanceTimersByTimeAsync(0);
    for (const attempt of [1, 2, 3, 4]) {
      expect(capabilities).toHaveBeenCalledTimes(attempt);
      expect(states.at(-1)).toEqual({ status: 'plugin', attempt });
      await vi.advanceTimersByTimeAsync(retryDelayMs(attempt));
    }
    expect(ready()).toEqual([]);
    // Updated on the store, the plugin is picked up by the next retry.
    capabilities.mockResolvedValue(storeCapabilities);
    await vi.advanceTimersByTimeAsync(retryDelayMs(5));
    expect(states.at(-1)).toMatchObject({ status: 'ready', capabilities: { orderCreate: MIN_ORDER_CREATE, register: MIN_REGISTER } });
  });

  it('gives the default rounding only to a connector that declares no capabilities read', async () => {
    mount({});
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ status: 'ready', settings: session.settings, capabilities: undefined });
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

describe('readCapabilities, the outbox refresh', () => {
  it('rejects a read that has not settled within READ_TIMEOUT_MS, and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const capabilities = vi.fn(({ signal: given }: { signal: AbortSignal }) => { signal = given; return new Promise(() => {}); });
    const read = readCapabilities(session, { capabilities } as unknown as TallyConnector);
    const settled = vi.fn();
    read.catch(settled);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(new Error(`No answer within ${READ_TIMEOUT_MS} ms`));
    expect(signal!.aborted).toBe(true);
  });
});
