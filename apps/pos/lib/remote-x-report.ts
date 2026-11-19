import type { CashMovement } from '@tallyui/pos';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { sessionContext, type Session } from './session';
import { xReportLines } from './x-report';

export const REGISTER_CLOSED_TEXT = 'This register has closed; its Z report is in the list.';
export const STORE_UNREACHABLE_TEXT = "Couldn't reach the store.";

/** One movement of the plugin's live session (packages/vendure-plugin/src/api/registers.controller.ts). */
export type MovementRead = {
  id: string; type: CashMovement['type']; amountMinor: number; reason: string | null; voids: string | null; createdAt: string; createdBy: string | null;
};
/** The plugin's live session on GET /tally/v1/registers/:id; an older plugin sends no movements. */
type LiveSessionRead = { id: string; status: 'open' | 'counting'; openedAt: string; openedBy: string | null; countedFloatMinor: number;
  expected: Record<string, number>; salesCount: number; movements?: MovementRead[] };
export type RemoteXReport = { lines: string[]; sessionId: string } | { notice: string | null; retry: boolean; refresh: boolean };

/**
 * The plugin's movements as TallyUI's: a plugin void row carries no amount and names its target in `voids`, while the
 * till's void copies its target's amount and reason and the target names its void in `voided_by`.
 */
export function cashMovementsFromRead(sessionId: string, rows: readonly MovementRead[]): CashMovement[] {
  return rows.map((row) => {
    const isVoid = row.type === 'void';
    const source = isVoid ? rows.find((target) => target.id === row.voids) ?? row : row;
    return {
      id: row.id, session_id: sessionId, type: row.type, amountMinor: source.amountMinor, reason: source.reason ?? '',
      created_at_gmt: row.createdAt, created_by: row.createdBy, voids: row.voids,
      voided_by: isVoid ? null : rows.find((other) => other.type === 'void' && other.voids === row.id)?.id ?? null,
    };
  });
}

/** Another register's open session with movements to print; this device prints its own from the drawer card. */
export function xReportOffered(registerId: string, { ownRegisterId, status, printable }: {
  ownRegisterId: string; status: 'open' | 'counting'; printable: readonly string[];
}): boolean {
  return registerId !== ownRegisterId && status === 'open' && printable.includes(registerId);
}

/** Reads the register's live session again and builds its X report, or the notice to show instead. */
export async function remoteXReport(session: Session, registerId: string, { store, currency, timezone, blind, printedAt }: {
  store: string; currency: string; timezone: string; blind: boolean; printedAt: string;
}): Promise<RemoteXReport> {
  const unreachable = { notice: STORE_UNREACHABLE_TEXT, retry: true, refresh: false }, closed = { notice: REGISTER_CLOSED_TEXT, retry: false, refresh: true };
  const response = await fetch(`${session.url}/tally/v1/registers/${encodeURIComponent(registerId)}?take=1`, { headers: sessionContext(session).headers })
    .catch(() => null);
  if (!response) return unreachable;
  if (response.status === 401 || response.status === 403) return { notice: SESSION_ENDED_TEXT, retry: false, refresh: false };
  if (response.status === 404) return closed;
  if (!response.ok) return unreachable;
  const { session: live }: { session: LiveSessionRead | null } = await response.json();
  if (!live) return closed;
  if (live.status !== 'open' || !Array.isArray(live.movements)) return { notice: null, retry: false, refresh: true };
  const lines = xReportLines({
    session: { id: live.id, register_id: registerId, status: 'open', opened_at_gmt: live.openedAt, opened_by: live.openedBy, counted_float_minor: live.countedFloatMinor },
    expected: live.expected, salesCount: live.salesCount, blind, movements: cashMovementsFromRead(live.id, live.movements),
  }, { store, currency, timezone, printedAt });
  return { lines, sessionId: live.id };
}
