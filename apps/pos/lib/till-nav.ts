export type TillNavId = 'pos' | 'orders' | 'register' | 'settings' | 'support';

export interface TillNavEntry {
  id: TillNavId;
  label: string;
  badge?: number;
  group?: 'bottom';
}

/**
 * The frame's nav items (spec B1): POS always; Orders where the orders store is open, badged with the orders that need
 * attention; Register while the session is open; Settings and Support at the foot.
 */
export function tillNavEntries({ ordersShown, registerShown, rejected }: {
  ordersShown: boolean; registerShown: boolean; rejected: number;
}): TillNavEntry[] {
  const entries: TillNavEntry[] = [{ id: 'pos', label: 'POS' }];
  if (ordersShown) entries.push({ id: 'orders', label: 'Orders', ...(rejected > 0 ? { badge: rejected } : {}) });
  if (registerShown) entries.push({ id: 'register', label: 'Register' });
  entries.push({ id: 'settings', label: 'Settings', group: 'bottom' });
  entries.push({ id: 'support', label: 'Support', group: 'bottom' });
  return entries;
}

/** The lit item: the panel that covers the sale, else POS. */
export function activeTillNav({ ordersOpen, registerOpen }: { ordersOpen: boolean; registerOpen: boolean }): TillNavId {
  return ordersOpen ? 'orders' : registerOpen ? 'register' : 'pos';
}
