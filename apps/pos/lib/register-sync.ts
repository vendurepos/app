import { useEffect, useState } from 'react';
import { watchFresh, type OutboxState, type RegisterCommand } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';

// holdClosuresForOrders' retry reason (lib/closure-hold.ts): the register outbox starts a stuck clock on it like on any
// answered failure, but a held closure is waiting, not failing; the "Closing — waiting for n orders" line covers it.
const ORDERS_PENDING = 'orders_pending';

const updates = (n: number) => `${n} till ${n === 1 ? 'update' : 'updates'}`;

/**
 * The one line the header shows about till updates (register commands), the most pressing first; undefined while they
 * are only pending or held behind orders. `rejected` counts the commands the store refused one by one: the register
 * outbox's state never carries them, yet each halts its register's later commands (the #81 review). The words follow
 * TallyUI's SyncStatus for till updates.
 */
export function registerSyncNotice({ authRequired, refused, stuck, pending }: OutboxState, rejected: number): string | undefined {
  if (authRequired) return "Till updates aren't sending: this till needs to sign in to the online store again.";
  const them = rejected === 1 ? 'it' : 'them';
  if (rejected) return `${updates(rejected)} ${rejected === 1 ? 'needs' : 'need'} attention · The online store refused ${them}, `
    + `and later till updates wait behind ${them}. Ask the store owner to look at the till's sync log.`;
  if (refused) return `${updates(pending)} waiting to sync · The online store refused the last send. `
    + 'This till will try again with the next till update, or when the app is reopened.';
  if (stuck?.orders.some(({ reason }) => reason !== ORDERS_PENDING)) {
    return "Till updates aren't reaching the online store. Keep selling: they're saved on this till and will send by themselves.";
  }
}

/** The number of register commands the store rejected; 0 while there is no collection. */
export function useRejectedRegisterCommands(commands: RxCollection<RegisterCommand> | null) {
  const [rejected, setRejected] = useState(0);
  useEffect(() => {
    setRejected(0);
    if (!commands) return;
    const subscription = watchFresh(commands, { selector: { syncStatus: 'rejected' } }).subscribe((found) => setRejected(found.length));
    return () => subscription.unsubscribe();
  }, [commands]);
  return rejected;
}
