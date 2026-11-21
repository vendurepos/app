import { RequestContext } from '@vendure/core';
import { tallyPosApproveVariance } from '../config/permissions';
import type { CommandResult } from '../vendored/commands';

/**
 * 4.3c (Front desk ruling, 2026-11-21): a till that counts blind does not receive the register's derived figures. A caller
 * without ApproveTallyPosVariance on the active channel (SuperAdmin holds it) gets these keys omitted, never null; a till keeps
 * every movement's own amount and the opening float. Applied when a response is sent, never when the ledger stores a result,
 * so a replay to a holder still carries them. `register_approval_required`'s `data.variance` is kept: the till posts it back.
 */
export const WITHHELD_SESSION_KEYS = ['expected', 'paidInMinor', 'paidOutMinor'] as const;
export const WITHHELD_CLOSURE_KEYS = ['expected', 'variance', 'tillExpected', 'paidInMinor', 'paidOutMinor'] as const;
export const WITHHELD_RESULT_SESSION_KEYS = ['expected'] as const;
export const WITHHELD_RESULT_CLOSURE_KEYS = ['expected', 'variance'] as const;

export const countsBlind = (ctx: RequestContext) => !ctx.userHasPermissions([tallyPosApproveVariance.Permission]);

const without = <T extends object>(value: T, keys: readonly string[]): T =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;

/** `GET /registers/:id` for this caller. */
export function blindRegisterRead<R extends { session: object | null; closures: { items: object[] } }>(ctx: RequestContext, read: R): R {
  if (!countsBlind(ctx)) return read;
  return { ...read, session: read.session && without(read.session, WITHHELD_SESSION_KEYS),
    closures: { ...read.closures, items: read.closures.items.map(item => without(item, WITHHELD_CLOSURE_KEYS)) } };
}

/** A register command's answer (fresh, replayed or concurrent) for this caller. */
export function blindCommandResult(ctx: RequestContext, result: CommandResult): CommandResult {
  if (!result.register || !countsBlind(ctx)) return result;
  const { session, closure } = result.register;
  return { ...result, register: { ...result.register,
    ...(session ? { session: without(session, WITHHELD_RESULT_SESSION_KEYS) } : {}),
    ...(closure ? { closure: without(closure, WITHHELD_RESULT_CLOSURE_KEYS) } : {}) } };
}
