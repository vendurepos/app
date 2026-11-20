import { openSince } from './open-since';
import { isClosingStatus } from './register-conflict';
import { sessionContext, type Session } from './session';

/** One row of the plugin's GET /tally/v1/registers (packages/vendure-plugin/src/api/registers.controller.ts). */
export type ListedRegister = {
  id: string; receivedAt: string; lastDeviceName: string | null;
  session: null | { status: 'open' | 'counting'; openedAt: string; openedBy: string | null; deviceName: string | null };
};
export type RegisterChoice = { id: string; label: string; status: string | null };

export const OWN_REGISTER_LABEL = 'This device';
export const CLOSE_FIRST_TEXT = 'Close the register first';

/** A register has no name of its own (the plugin's rows, not a Vendure entity): its last device's name, else "Register <first 8 of id>". */
export function registerLabel(register: Pick<ListedRegister, 'id' | 'lastDeviceName'>): string {
  return register.lastDeviceName?.trim() || `Register ${register.id.slice(0, 8)}`;
}

/** The register side sheet's title (CHECKLIST 6.6c): the bound register's last device name, or undefined (RegisterPanel then reads "Register"). */
export function registerTitle(listed: readonly Pick<ListedRegister, 'id' | 'lastDeviceName'>[], boundId: string): string | undefined {
  return listed.find((register) => register.id === boundId)?.lastDeviceName?.trim() || undefined;
}

/** "Open since 14:38 on Front till" (openSince's form; no " on …" without a device name); null without a live session or a listed register. */
export function registerStatus(register: ListedRegister | undefined, now: Date): string | null {
  const session = register?.session;
  if (!session) return null;
  const since = `Open since ${openSince(new Date(session.openedAt), now)}`;
  return session.deviceName ? `${since} on ${session.deviceName}` : since;
}

/** v2's "Which register is this device at?": this till's own register first as "This device", then the others in the list's order. */
export function registerChoices(ownId: string, listed: readonly ListedRegister[], now: Date): RegisterChoice[] {
  return [
    { id: ownId, label: OWN_REGISTER_LABEL, status: registerStatus(listed.find(r => r.id === ownId), now) },
    ...listed.filter(r => r.id !== ownId).map(r => ({ id: r.id, label: registerLabel(r), status: registerStatus(r, now) })),
  ];
}

/** The cashier sheet's Register row (CHECKLIST 6.1): the bound register as the picker labels it, "Register <first 8>" when unlisted. */
export function boundRegisterLabel(ownId: string, listed: readonly ListedRegister[], boundId: string): string {
  return registerChoices(ownId, listed, new Date()).find((c) => c.id === boundId)?.label
    ?? registerLabel({ id: boundId, lastDeviceName: null });
}

let tillHoldsSession = false;

/** Set by app/index.tsx, which stays mounted under the Settings panel: the till holds a live session on its bound register. */
export function setTillHoldsSession(held: boolean): void {
  tillHoldsSession = held;
}

/** The till holds its register (Settings refuses another) while its session is open, or counting or closed until that session's closure is written (isClosingStatus). */
export function holdsRegister(status: string | undefined, closureWritten: boolean): boolean {
  return status === 'open' || (isClosingStatus(status) && !closureWritten);
}

/** Picking another register while this till holds a live session is refused; picking the bound one again never is. */
export function pickRefusal(picked: string, bound: string, holdsSession: boolean = tillHoldsSession): string | null {
  return holdsSession && picked !== bound ? CLOSE_FIRST_TEXT : null;
}

/** GET /tally/v1/registers with the session's headers; throws on a status other than 200. */
export async function fetchRegisters(session: Session): Promise<ListedRegister[]> {
  const response = await fetch(`${session.url}/tally/v1/registers`, { headers: sessionContext(session).headers });
  if (!response.ok) throw new Error(`GET /tally/v1/registers answered ${response.status}`);
  return (await response.json()).items;
}
