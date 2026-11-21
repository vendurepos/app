import type { ServerCapabilities } from '@tallyui/core';
import { closureVariance } from '@tallyui/pos';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import { STORE_UNREACHABLE_TEXT } from './remote-x-report';
import { sessionContext, type Session } from './session';

/** The store checks a manager's sign-in (#332): contract 3, the store's registerApproval, and a session the store holds. */
export function usesStoreApproval(capabilities: ServerCapabilities | undefined, liveAtStore: boolean): boolean {
  return (capabilities?.register ?? 0) >= 3 && capabilities?.registerApproval !== undefined && liveAtStore;
}

/** The variance the route and closeSession both bind to: closureVariance(counted, expected), keeping only cash and external. */
export function approvalVariance(counted: Record<string, number>, expected: Record<string, number>): Record<string, number> {
  // The route takes only cash and external, and the close's closureVariance must equal what it approved. The plugin's
  // strict shape refuses any other counted or tillExpected key on a closure, so on a real close nothing is dropped.
  return Object.fromEntries(Object.entries(closureVariance(counted, expected)).filter(([key]) => key === 'cash' || key === 'external'));
}

export type ManagerApproval = { ok: true; approval: string; approvedBy: string; approvedByName: string } | { ok: false; message: string };

const CODE_MESSAGES: Record<string, string> = {
  approval_invalid_credentials: 'The username or password is wrong.',
  approval_forbidden: "This user can't approve register variances.",
  approval_rate_limited: 'Too many failed approvals. Try again in a few minutes.',
  approval_session_unknown: 'The store no longer has this register session open.',
  approval_session_closed: 'The store no longer has this register session open.',
  approval_request_unknown: 'The store has no refused closure to approve for this session.',
};

type Credentials = { sessionId: string; username: string; password: string };
/** 4.3d: a first close posts the variance the till computed; a refused closure posts its id, so a blind till sends no figure. */
export type ApprovalInput = Credentials & ({ variance: Record<string, number> } | { closureId: string });

/** POST /tally/v1/register-approvals. The password goes only into this request's body; nothing here logs or keeps it. */
export async function requestManagerApproval(session: Session, input: ApprovalInput): Promise<ManagerApproval> {
  return (await postApproval(session, input)).result;
}

/**
 * A refused closure's approval: by closure id, else (a plugin from before 4.3d, which answers 400 invalid_payload to a
 * closureId and still sends the refusal's variance) once more with the variance TallyUI read from the refusal.
 */
export async function requestReapproval(session: Session, input: Credentials & { closureId: string; variance: Record<string, number> }): Promise<ManagerApproval> {
  const { closureId, variance, ...credentials } = input;
  const first = await postApproval(session, { ...credentials, closureId });
  return first.legacy ? requestManagerApproval(session, { ...credentials, variance }) : first.result;
}

async function postApproval(session: Session, input: ApprovalInput): Promise<{ result: ManagerApproval; legacy?: boolean }> {
  const { sessionId, username, password } = input;
  const figure = 'closureId' in input ? { closureId: input.closureId } : { variance: input.variance };
  const response = await fetch(`${session.url}/tally/v1/register-approvals`, {
    method: 'POST',
    headers: { ...sessionContext(session).headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...figure, username, password }),
  }).catch(() => null);
  if (!response) return { result: { ok: false, message: STORE_UNREACHABLE_TEXT } };
  const body: unknown = await response.json().catch(() => null);
  const field = (name: string) => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined);
  if (response.status === 200 && typeof field('approval') === 'string') {
    return { result: { ok: true, approval: field('approval') as string, approvedBy: String(field('approvedBy') ?? ''),
      approvedByName: String(field('approvedByName') ?? '') } };
  }
  // By the body's code first: the route's own 401 and 403 are about the manager, not the till.
  const code = field('code');
  const legacy = response.status === 400 && code === 'invalid_payload';
  if (typeof code === 'string' && Object.hasOwn(CODE_MESSAGES, code)) return { result: { ok: false, message: CODE_MESSAGES[code] } };
  if (response.status === 401 || response.status === 403) return { result: { ok: false, message: SESSION_ENDED_TEXT } };
  return { result: { ok: false, message: "The store couldn't approve this count. Try again." }, legacy };
}
