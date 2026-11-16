import { describe, expect, it } from 'vitest';
import { activeTillNav, tillNavEntries } from './till-nav';

describe('tillNavEntries', () => {
  it('shows POS and Settings alone before the orders store opens and with no open session', () => {
    expect(tillNavEntries({ ordersShown: false, registerShown: false, rejected: 0 })).toEqual([
      { id: 'pos', label: 'POS' },
      { id: 'settings', label: 'Settings', group: 'bottom' },
      { id: 'support', label: 'Support', group: 'bottom' },
    ]);
  });

  it('adds Orders and Reports, badges Orders only with rejected orders, and adds Register while the session is open', () => {
    expect(tillNavEntries({ ordersShown: true, registerShown: true, rejected: 2 })).toEqual([
      { id: 'pos', label: 'POS' },
      { id: 'orders', label: 'Orders', badge: 2 },
      { id: 'reports', label: 'Reports' },
      { id: 'register', label: 'Register' },
      { id: 'settings', label: 'Settings', group: 'bottom' },
      { id: 'support', label: 'Support', group: 'bottom' },
    ]);
    expect(tillNavEntries({ ordersShown: true, registerShown: false, rejected: 0 })[1]).toEqual({ id: 'orders', label: 'Orders' });
  });
});

describe('activeTillNav', () => {
  it('lights the open panel, Orders then Reports then Register, else POS', () => {
    expect(activeTillNav({ ordersOpen: false, reportsOpen: false, registerOpen: false })).toBe('pos');
    expect(activeTillNav({ ordersOpen: false, reportsOpen: false, registerOpen: true })).toBe('register');
    expect(activeTillNav({ ordersOpen: true, reportsOpen: false, registerOpen: true })).toBe('orders');
    expect(activeTillNav({ ordersOpen: false, reportsOpen: true, registerOpen: true })).toBe('reports');
    expect(activeTillNav({ ordersOpen: true, reportsOpen: true, registerOpen: true })).toBe('orders');
  });
});
