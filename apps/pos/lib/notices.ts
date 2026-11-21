import type { ServerCapabilities } from '@tallyui/core';
import { MIN_ORDER_CREATE, MIN_ORDER_CREATE_CHARGES, MIN_ORDER_CREATE_NOTE, MIN_REGISTER } from './use-sale-settings';

export interface TillNotice { id: string; title: string; body: string }

/** The till's notices (v2 parity 11.1), from what the app already reads: today, one notice while the store's VendurePOS plugin is below what this app needs. No capabilities read yet: no notices. */
export function tillNotices({ capabilities }: { capabilities?: ServerCapabilities }): TillNotice[] {
  if (!capabilities) return [];
  const held: string[] = [];
  // Written so a missing or non-numeric version counts as below, as useSaleSettings reads it.
  if (!(capabilities.orderCreate >= MIN_ORDER_CREATE)) held.push('sales');
  else {
    if (!(capabilities.orderCreate >= MIN_ORDER_CREATE_CHARGES)) held.push('fee and shipping charges');
    if (!(capabilities.orderCreate >= MIN_ORDER_CREATE_NOTE)) held.push('the customer note');
  }
  if (!((capabilities.orderRefund ?? 0) >= 1)) held.push('refunds');
  if (!((capabilities.register ?? 0) >= MIN_REGISTER)) held.push('the register');
  if (held.length === 0) return [];
  const list = held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}` : held[0];
  const verb = held.length === 1 && (held[0] === 'the register' || held[0] === 'the customer note') ? 'is' : 'are';
  return [{
    id: 'plugin-update', title: 'Update the VendurePOS plugin',
    body: `This store's VendurePOS plugin is missing or older than this app needs, so ${list} ${verb} held back. Update the VendurePOS plugin on the store.`,
  }];
}
