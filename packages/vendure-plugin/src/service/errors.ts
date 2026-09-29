import { randomUUID } from 'node:crypto';
import { Logger, isGraphQlErrorResult } from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';

export const loggerCtx = 'TallyPosPlugin';

/**
 * TallyUI ADR-038's `platform_error` amendment: a stored rejection for an ErrorResult on the
 * plugin's permanent list (classification.ts), with the platform's own code and message in `data`
 * as `platformCode` and `platformMessage`.
 */
export const PLATFORM_ERROR_CODE = 'platform_error';

/** Front desk ruling 1: the plugin's own programming error after a complete rollback, stored like a refusal. */
export const INTERNAL_ERROR_CODE = 'internal_error';

/** A business refusal found after the claim: the sale rolls back and the rejection is stored on the claim. */
export class BusinessRejection extends Error {
  constructor(readonly code: string, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * A store-configuration fault found after the claim (a refused PaymentSettled with enough payment,
 * review 13): the order and the claim roll back and, as before the claim, nothing is stored.
 */
export class StoreConfigurationRefusal extends Error {}

/** A returned ErrorResult, turned into a throw so the sale's savepoint rolls back (ADR 0002 §2). */
export class ErrorResultThrown extends Error {
  constructor(readonly result: GraphQLErrorResult) {
    super(result.errorCode);
  }
}

/**
 * `lock`: the claim's lock_timeout (55P03) on another request's uncommitted claim. `deadlock`: a
 * deadlock or serialization failure (N5). `resources`: the server is short of resources (N1).
 * A lock_timeout after the claim is a `timeout`. `unclassified`: an ErrorResult off the permanent
 * list, or an error nothing else classifies (the amendment: never `platform_error`). `needs_admin`:
 * the ledger row awaits an admin, whose resends answer 409 like `lock`.
 */
export type TransientKind = 'lock' | 'deadlock' | 'connection' | 'timeout' | 'resources' | 'unclassified' | 'needs_admin';

/**
 * ADR 0002 §2: the failures that may be retried. Nothing is stored, and the transaction, claim
 * included, has rolled back, except for `needs_admin`, whose sale is committed and whose claim
 * stays until an admin resolves it. The route answers `lock` and `needs_admin` as 409
 * `in_progress` and every other kind as 503 `transient`.
 */
export class TransientCommandError extends Error {
  constructor(readonly commandId: string, readonly kind: TransientKind, readonly cause: unknown) {
    super(`Transient ${kind} failure for command ${commandId}`);
  }
}

/** ADR 0002 §2 "Error results become throws": a returned ErrorResult rolls the sale back. */
export function unwrap<T>(result: T): Exclude<T, GraphQLErrorResult> {
  if (isGraphQlErrorResult(result)) throw new ErrorResultThrown(result as GraphQLErrorResult);
  return result as Exclude<T, GraphQLErrorResult>;
}

let internalErrors = 0;

/** How many programming errors this process has stored as `internal_error` (ruling 8). */
export function internalErrorCount(): number {
  return internalErrors;
}

/**
 * Logs a programming error after the claim and turns it into the stored `internal_error`.
 * The raw message goes only to the log, under a random correlation id the result carries (N7): it
 * can hold internals, so it is never stored or returned.
 */
export function internalErrorFor(commandId: string, error: unknown): BusinessRejection {
  internalErrors += 1;
  const correlationId = randomUUID();
  const message = error instanceof Error ? error.message : String(error);
  Logger.error(`order.create ${commandId} failed unexpectedly (correlationId ${correlationId}): ${message}`, loggerCtx,
    error instanceof Error ? error.stack : undefined);
  return new BusinessRejection(INTERNAL_ERROR_CODE, 'The server could not record the order',
    { message: 'Internal error', correlationId });
}

// Postgres SQLSTATEs: 55P03 lock_not_available (the claim's lock_timeout); 40P01 deadlock_detected
// and 40001 serialization_failure; 57014 query_canceled (statement_timeout) and 25P03
// idle_in_transaction_session_timeout; class 08 connection exceptions except 08P01
// protocol_violation (deterministic), 57P01–57P03 server shutdown or start-up, 57P05
// idle_session_timeout and 40003 statement_completion_unknown (N1); class 53 insufficient
// resources except 53400 configuration_limit_exceeded, which a retry meets again. Node socket
// codes and the pg driver's uncoded connection messages are connection failures too.
const DEADLOCK_CODES = new Set(['40P01', '40001']);
const NODE_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const PG_CONNECTION_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i;

/** The named transient kind of a thrown error, or undefined when none fits (the caller then treats it as `unclassified`). */
export function transientKind(error: unknown): TransientKind | undefined {
  const driverError = (error as { driverError?: unknown })?.driverError ?? error;
  const code = (driverError as { code?: unknown })?.code;
  if (code === '55P03') return 'lock';
  if (typeof code === 'string' && DEADLOCK_CODES.has(code)) return 'deadlock';
  if (code === '57014' || code === '25P03') return 'timeout';
  if (typeof code === 'string' && /^53/.test(code) && code !== '53400') return 'resources';
  if (typeof code === 'string' && ((/^08/.test(code) && code !== '08P01') || /^57P0[1235]$/.test(code)
    || code === '40003' || NODE_CONNECTION_CODES.has(code))) {
    return 'connection';
  }
  const message = (driverError as { message?: unknown })?.message;
  if (typeof message === 'string' && PG_CONNECTION_MESSAGES.test(message)) return 'connection';
  return undefined;
}
