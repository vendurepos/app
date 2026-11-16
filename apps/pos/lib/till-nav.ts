export type TillNavId = 'pos' | 'orders' | 'customers' | 'reports' | 'register' | 'settings' | 'support';

export interface TillNavEntry {
  id: TillNavId;
  label: string;
  badge?: number;
  group?: 'bottom';
}

/**
 * The frame's nav items: POS always; Orders, Customers and Reports where the orders store is open, Orders badged with those
 * needing attention; Register while the session is open; Settings and Support at the foot.
 */
export function tillNavEntries({ ordersShown, registerShown, rejected }: {
  ordersShown: boolean; registerShown: boolean; rejected: number;
}): TillNavEntry[] {
  const entries: TillNavEntry[] = [{ id: 'pos', label: 'POS' }];
  if (ordersShown) entries.push({ id: 'orders', label: 'Orders', ...(rejected > 0 ? { badge: rejected } : {}) },
    { id: 'customers', label: 'Customers' }, { id: 'reports', label: 'Reports' });
  if (registerShown) entries.push({ id: 'register', label: 'Register' });
  entries.push({ id: 'settings', label: 'Settings', group: 'bottom' });
  entries.push({ id: 'support', label: 'Support', group: 'bottom' });
  return entries;
}

/** The lit item: Orders, then Customers, then Reports, then Register when open, else POS. */
export function activeTillNav({ ordersOpen, customersOpen, reportsOpen, registerOpen }: { ordersOpen: boolean; customersOpen: boolean; reportsOpen: boolean; registerOpen: boolean }): TillNavId {
  return ordersOpen ? 'orders' : customersOpen ? 'customers' : reportsOpen ? 'reports' : registerOpen ? 'register' : 'pos';
}
