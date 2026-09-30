import { useEffect, useState } from 'react';
import type { RegisterCommandEnvelope } from '@tallyui/core';
import { readFresh, watchFresh, type CommandTransport, type PosOrder, type RegisterCommand } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { combineLatest } from 'rxjs';

/** The orders taken in `sessionId` still waiting to be sent, read fresh (a find: no index answers this count). */
export const pendingSessionOrders = (orders: RxCollection<PosOrder>) => (sessionId: string) =>
  readFresh(orders, { selector: { sessionId, syncStatus: 'pending' } }).then((found) => found.length);

const closureSessionId = ({ type, payload }: RegisterCommandEnvelope) =>
  type === 'register.closure.submit' && typeof payload.sessionId === 'string' ? payload.sessionId : undefined;

/**
 * Holds a `register.closure.submit` until its session's orders have been sent (Front desk ruling, #81 review): the
 * plugin freezes a write-once closure from the orders it has received, so one sent ahead of them would leave them out.
 * The commands before a held closure are sent on their own: the register outbox marks only the commands it has a result
 * for and sends again from the closure. A batch that starts with a held closure is a `retry` (`orders_pending`).
 */
export function holdClosuresForOrders(
  transport: CommandTransport<RegisterCommandEnvelope>, pendingOrders: (sessionId: string) => Promise<number>,
): CommandTransport<RegisterCommandEnvelope> {
  return {
    async send(batch) {
      for (const [index, command] of batch.entries()) {
        const sessionId = closureSessionId(command);
        if (sessionId === undefined || await pendingOrders(sessionId) === 0) continue;
        return index === 0 ? { kind: 'retry', reason: 'orders_pending' } : transport.send(batch.slice(0, index));
      }
      return transport.send(batch);
    },
  };
}

/** Returns a callback for each new pending count that calls `flush` when it drops, so a held closure goes at once. */
export function flushOnDrain(flush: () => void) {
  let last = Infinity;
  return (pending: number) => {
    if (pending < last) flush();
    last = pending;
  };
}

/** The pending orders of the sessions whose closure is still waiting to be sent; 0 when no closure waits on any. */
export function useClosureWaiting(commands: RxCollection<RegisterCommand> | null, orders: RxCollection<PosOrder> | null) {
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    setWaiting(0);
    if (!commands || !orders) return;
    const subscription = combineLatest([
      watchFresh(commands, { selector: { type: 'register.closure.submit', syncStatus: 'pending' } }),
      watchFresh(orders, { selector: { syncStatus: 'pending' } }),
    ]).subscribe(([closures, pending]) => {
      const held = new Set(closures.map(({ payload }) => payload.sessionId));
      setWaiting(pending.filter(({ sessionId }) => sessionId !== undefined && held.has(sessionId)).length);
    });
    return () => subscription.unsubscribe();
  }, [commands, orders]);
  return waiting;
}

/** Calls `flush` whenever `pending` drops (see `flushOnDrain`); `flush` is read once, so it must be stable. */
export function useFlushOnDrain(pending: number, flush: () => void) {
  const [onPending] = useState(() => flushOnDrain(flush));
  useEffect(() => onPending(pending), [onPending, pending]);
}
