import { describe, expect, it } from 'vitest';
import { activeTillNav, tillNavEntries } from './till-nav';

describe('tillNavEntries', () => {
  it('shows POS and Settings alone before the orders store opens and with no open session', () => {
    expect(tillNavEntries({ ordersShown: false, registerShown: false, rejected: 0 })).toEqual([
      { id: 'pos', label: 'POS' },
      { id: 'settings', label: 'Settings', group: 'bottom' },
    ]);
  });

  it('adds Orders, badged only with rejected orders, and Register while the session is open', () => {
    expect(tillNavEntries({ ordersShown: true, registerShown: true, rejected: 2 })).toEqual([
      { id: 'pos', label: 'POS' },
      { id: 'orders', label: 'Orders', badge: 2 },
      { id: 'register', label: 'Register' },
      { id: 'settings', label: 'Settings', group: 'bottom' },
    ]);
    expect(tillNavEntries({ ordersShown: true, registerShown: false, rejected: 0 })[1]).toEqual({ id: 'orders', label: 'Orders' });
  });
});

describe('activeTillNav', () => {
  it('lights the open panel, Orders first, else POS', () => {
    expect(activeTillNav({ ordersOpen: false, registerOpen: false })).toBe('pos');
    expect(activeTillNav({ ordersOpen: false, registerOpen: true })).toBe('register');
    expect(activeTillNav({ ordersOpen: true, registerOpen: true })).toBe('orders');
  });
});
