import { describe, expect, it } from 'vitest';
import { activeTillNav, tillNavEntries } from './till-nav';

describe('tillNavEntries', () => {
  it('shows POS and Settings alone before the orders store opens and with no open session', () => {
    expect(tillNavEntries({ ordersShown: false, customersShown: true, registerShown: false, rejected: 0 })).toEqual([
      { id: 'pos', label: 'POS' },
      { id: 'products', label: 'Products' },
      { id: 'health', label: 'Store health', group: 'bottom' },
      { id: 'settings', label: 'Settings', group: 'bottom' },
      { id: 'support', label: 'Support', group: 'bottom' },
    ]);
  });

  it('adds Orders, Customers and Reports, badges Orders only with rejected orders, and adds Register while the session is open', () => {
    expect(tillNavEntries({ ordersShown: true, customersShown: true, registerShown: true, rejected: 2 })).toEqual([
      { id: 'pos', label: 'POS' },
      { id: 'products', label: 'Products' },
      { id: 'orders', label: 'Orders', badge: 2 },
      { id: 'customers', label: 'Customers' },
      { id: 'reports', label: 'Reports' },
      { id: 'register', label: 'Register' },
      { id: 'health', label: 'Store health', group: 'bottom' },
      { id: 'settings', label: 'Settings', group: 'bottom' },
      { id: 'support', label: 'Support', group: 'bottom' },
    ]);
    expect(tillNavEntries({ ordersShown: true, customersShown: true, registerShown: false, rejected: 0 })[2]).toEqual({ id: 'orders', label: 'Orders' });
  });

  it('leaves Customers out for a role that cannot read customers', () => {
    expect(tillNavEntries({ ordersShown: true, customersShown: false, registerShown: false, rejected: 0 }).map(entry => entry.id))
      .toEqual(['pos', 'products', 'orders', 'reports', 'health', 'settings', 'support']);
  });
});

describe('activeTillNav', () => {
  it('lights the open panel, Orders then Customers then Reports then Register, else POS', () => {
    expect(activeTillNav({ ordersOpen: false, customersOpen: false, reportsOpen: false, registerOpen: false })).toBe('pos');
    expect(activeTillNav({ ordersOpen: false, customersOpen: false, reportsOpen: false, registerOpen: true })).toBe('register');
    expect(activeTillNav({ ordersOpen: false, customersOpen: false, reportsOpen: false, registerOpen: true, healthOpen: true })).toBe('health');
    expect(activeTillNav({ ordersOpen: true, customersOpen: false, reportsOpen: false, registerOpen: true })).toBe('orders');
    expect(activeTillNav({ ordersOpen: false, customersOpen: false, reportsOpen: true, registerOpen: true })).toBe('reports');
    expect(activeTillNav({ ordersOpen: true, customersOpen: false, reportsOpen: true, registerOpen: true })).toBe('orders');
    expect(activeTillNav({ ordersOpen: false, productsOpen: true, customersOpen: true, reportsOpen: false, registerOpen: true })).toBe('products');
    expect(activeTillNav({ ordersOpen: false, customersOpen: true, reportsOpen: true, registerOpen: true })).toBe('customers');
    expect(activeTillNav({ ordersOpen: true, customersOpen: true, reportsOpen: false, registerOpen: false })).toBe('orders');
  });
});
