export type TillNavId = 'pos' | 'products' | 'orders' | 'customers' | 'reports' | 'health' | 'register' | 'settings' | 'support';

export interface TillNavEntry {
  id: TillNavId;
  label: string;
  badge?: number;
  group?: 'bottom';
}

/**
 * The frame's nav items: POS and Products always for the local catalogue; Orders, Customers and Reports where the orders store is open, Orders badged with those
 * needing attention; Customers where the role can read the store's customers; Register while the session is open; Store health, Settings and Support at the foot.
 */
export function tillNavEntries({ ordersShown, customersShown, registerShown, rejected }: {
  ordersShown: boolean; customersShown: boolean; registerShown: boolean; rejected: number;
}): TillNavEntry[] {
  const entries: TillNavEntry[] = [{ id: 'pos', label: 'POS' }];
  entries.push({ id: 'products', label: 'Products' });
  if (ordersShown) entries.push({ id: 'orders', label: 'Orders', ...(rejected > 0 ? { badge: rejected } : {}) },
    ...(customersShown ? [{ id: 'customers' as const, label: 'Customers' }] : []), { id: 'reports', label: 'Reports' });
  if (registerShown) entries.push({ id: 'register', label: 'Register' });
  entries.push({ id: 'health', label: 'Store health', group: 'bottom' });
  entries.push({ id: 'settings', label: 'Settings', group: 'bottom' });
  entries.push({ id: 'support', label: 'Support', group: 'bottom' });
  return entries;
}

/** The lit item: Orders, then Products, then Customers, then Reports, then Store health, then Register when open, else POS. */
export function activeTillNav({ ordersOpen, productsOpen, customersOpen, reportsOpen, healthOpen, registerOpen }: { ordersOpen: boolean; productsOpen?: boolean; customersOpen: boolean; reportsOpen: boolean; healthOpen?: boolean; registerOpen: boolean }): TillNavId {
  return ordersOpen ? 'orders' : productsOpen ? 'products' : customersOpen ? 'customers' : reportsOpen ? 'reports' : healthOpen ? 'health' : registerOpen ? 'register' : 'pos';
}
