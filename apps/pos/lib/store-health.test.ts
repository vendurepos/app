import { describe, expect, it } from 'vitest';
import { changesWaiting, readyToSell, recordsOnDevice } from './store-health';

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
