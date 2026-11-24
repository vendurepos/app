import { useEffect, useState } from 'react';
import { formatMoney, type SyncContext } from '@tallyui/core';
import { channelPermissions } from './channel-permissions';
import { sessionContext, type Session } from './session';

// Front desk ruling, 2026-11-21: the variance approver counts with the figures; everyone else counts blind. The plugin now withholds them from GET /registers/:id and the register command replies for the same callers (4.3c).
export const UNBLIND_PERMISSION = 'ApproveTallyPosVariance';
/** Blind unless the active channel's permissions hold the approve permission; unknown permissions count blind. */
export function blindFrom(permissions: readonly string[] | undefined): boolean { return !permissions?.includes(UNBLIND_PERMISSION); }
export async function registerBlind(context: SyncContext): Promise<boolean> { return blindFrom(await channelPermissions(context)); }
/** Blind until the permission has loaded, and again from each new session until it has; a late answer is dropped. */
export function useRegisterBlind(session: Session): boolean {
  const [blind, setBlind] = useState(true);
  useEffect(() => {
    setBlind(true);
    let cancelled = false;
    registerBlind(sessionContext(session)).then(result => { if (!cancelled) setBlind(result); });
    return () => { cancelled = true; };
  }, [session]);
  return blind;
}
export function blindClosureText(countedCashMinor: number, currency: string): string { return `Cash counted ${formatMoney({ amount: countedCashMinor, currency })} · sent for review`; }
