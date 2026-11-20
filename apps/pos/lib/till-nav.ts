export type TillNavId = 'pos' | 'products' | 'orders' | 'customers' | 'reports' | 'notifications' | 'health' | 'register' | 'settings' | 'support';

export interface TillNavEntry {
  id: TillNavId;
  label: string;
  badge?: number;
  group?: 'bottom';
}

/**
 * The frame's nav items: POS and Products always for the local catalogue; Orders, Customers and Reports where the orders store is open, Orders badged with those
 * needing attention; Customers where the role can read the store's customers; Register while the session is open; Notifications (badged with the notice count), Store health (badged with the unread errors), Settings and Support at the foot.
 */
export function tillNavEntries({ ordersShown, customersShown, registerShown, rejected, notices, unreadErrors }: {
  ordersShown: boolean; customersShown: boolean; registerShown: boolean; rejected: number; notices?: number; unreadErrors?: number;
}): TillNavEntry[] {
  const entries: TillNavEntry[] = [{ id: 'pos', label: 'POS' }];
  entries.push({ id: 'products', label: 'Products' });
  if (ordersShown) entries.push({ id: 'orders', label: 'Orders', ...(rejected > 0 ? { badge: rejected } : {}) },
    ...(customersShown ? [{ id: 'customers' as const, label: 'Customers' }] : []), { id: 'reports', label: 'Reports' });
  if (registerShown) entries.push({ id: 'register', label: 'Register' });
  entries.push({ id: 'notifications', label: 'Notifications', group: 'bottom', ...(notices ? { badge: notices } : {}) });
  entries.push({ id: 'health', label: 'Store health', group: 'bottom', ...(unreadErrors ? { badge: unreadErrors } : {}) });
  entries.push({ id: 'settings', label: 'Settings', group: 'bottom' });
  entries.push({ id: 'support', label: 'Support', group: 'bottom' });
  return entries;
}

/** The lit item: Notifications, then Settings, then Orders, then Products, then Customers, then Reports, then Store health, then Register when open, else POS. */
export function activeTillNav({ ordersOpen, productsOpen, customersOpen, reportsOpen, healthOpen, registerOpen, notificationsOpen, settingsOpen }: { ordersOpen: boolean; productsOpen?: boolean; customersOpen: boolean; reportsOpen: boolean; healthOpen?: boolean; registerOpen: boolean; notificationsOpen?: boolean; settingsOpen?: boolean }): TillNavId {
  return notificationsOpen ? 'notifications' : settingsOpen ? 'settings' : ordersOpen ? 'orders' : productsOpen ? 'products' : customersOpen ? 'customers' : reportsOpen ? 'reports' : healthOpen ? 'health' : registerOpen ? 'register' : 'pos';
}
