import { useEffect, useState } from 'react';
import { formatMoney, type SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';

// Front desk ruling, 2026-11-21: the variance approver counts with the figures; everyone else counts blind. A display rule: GET /registers/:id still returns them until AUDIT.md:130 lands.
export const UNBLIND_PERMISSION = 'ApproveTallyPosVariance';
/** Blind unless the active channel's permissions hold the approve permission; errors and missing data count blind. */
export function blindFromPermissions(body: unknown): boolean {
  const answer = body as { errors?: unknown[]; data?: { me?: { channels?: { id: string; permissions?: string[] }[] }; activeChannel?: { id: string } } } | null;
  const active = answer?.data?.activeChannel?.id;
  const channel = answer?.errors?.length || active === undefined ? undefined : answer?.data?.me?.channels?.find(channel => channel.id === active);
  return !channel?.permissions?.includes(UNBLIND_PERMISSION);
}
export async function registerBlind(context: SyncContext): Promise<boolean> {
  try {
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      body: JSON.stringify({ query: 'query RegisterPermissions { me { channels { id permissions } } activeChannel { id } }' }) });
    return response.ok ? blindFromPermissions(await response.json()) : true;
  } catch { return true; }
}
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
