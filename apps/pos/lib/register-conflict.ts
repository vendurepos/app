import type { useRegisterSession } from '@tallyui/pos';

type Conflict = ReturnType<typeof useRegisterSession>['conflict'];

/** A session in one of these states is being counted or closed; open, conflict, superseded and abandoned are not. */
export function isClosingStatus(status: string | undefined): boolean {
  return status === 'counting' || status === 'closed';
}

/** The card's one line about the other till, the plainest first. */
export function registerConflictText(conflict: Conflict): string {
  if (!conflict) return 'This register is open on another till.';
  if (conflict.takingOver) return 'Taking over this register… waiting for the online store.';
  const where = conflict.deviceName?.trim() || 'another till';
  const openedAt = conflict.openedAt ? new Date(conflict.openedAt) : null;
  const since = openedAt && !Number.isNaN(openedAt.getTime()) ? ' since ' + openedAt.toLocaleString() : '';
  const by = conflict.openedBy ? ' by ' + conflict.openedBy : '';
  return 'This register is open on ' + where + since + by + '.';
}

/** Take over is offered only from register contract 2 (ADR-078); before it the store cannot hand a register over. */
export function canTakeOver(registerContract: number | undefined): boolean {
  return (registerContract ?? 0) >= 2;
}
