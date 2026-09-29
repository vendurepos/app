import { Logger, isGraphQlErrorResult } from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';

export const loggerCtx = 'TallyPosPlugin';

/**
 * The contract code for an ErrorResult the plugin does not map (ADR 0002 §2 "any other
 * ErrorResult"; Front desk ruling 1): a stored rejection that carries the platform's own code and
 * message in `data` as `platformCode` and `platformMessage`.
 */
export const UNKNOWN_REJECTION_CODE = 'platform_error';

/** Front desk ruling 8: an unexpected, non-transient exception after the claim, stored like a refusal. */
export const INTERNAL_ERROR_CODE = 'internal_error';

/** A business refusal found after the claim: the order rolls back and the rejection is stored. */
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

export type TransientKind = 'lock' | 'connection' | 'timeout';

/**
 * ADR 0002 §2: the only failures that may be retried. Nothing is stored, and the transaction,
 * claim included, has rolled back. VP2 answers `lock` on the claim as 409 `in_progress` and the
 * rest as 503 `transient`.
 */
export class TransientCommandError extends Error {
  constructor(readonly commandId: string, readonly kind: TransientKind, readonly cause: unknown) {
    super(`Transient ${kind} failure for command ${commandId}`);
  }
}

// ErrorResults with a contract code of their own. `underpaid` is decided where the
// PaymentSettled transition is refused, because it depends on the payments. A shortage that
// createFulfillment finds is the same final answer as one addItemToOrder finds (ruling 3).
const KNOWN_ERROR_RESULTS: Record<string, string> = {
  INSUFFICIENT_STOCK_ERROR: 'insufficient_stock',
  INSUFFICIENT_STOCK_ON_HAND_ERROR: 'insufficient_stock',
};

export function rejectionFor(error: GraphQLErrorResult): BusinessRejection {
  // Outside GraphQL an ErrorResult's message is its untranslated key (for most types, the code);
  // its specifics are separate fields, so the readable message appends the primitive ones.
  const { errorCode, message, __typename, ...fields } = error as GraphQLErrorResult & Record<string, unknown>;
  const details = Object.fromEntries(Object.entries(fields).filter(([, value]) => value === null || typeof value !== 'object'));
  const readable = Object.keys(details).length ? `${message}: ${JSON.stringify(details)}` : message;
  const known = KNOWN_ERROR_RESULTS[errorCode];
  if (known) return new BusinessRejection(known, readable);
  return new BusinessRejection(UNKNOWN_REJECTION_CODE, readable, { platformCode: errorCode, platformMessage: message });
}

/** ADR 0002 §2 "Error results become throws": a returned ErrorResult rolls the order back. */
export function unwrap<T>(result: T): Exclude<T, GraphQLErrorResult> {
  if (isGraphQlErrorResult(result)) throw rejectionFor(result as GraphQLErrorResult);
  return result as Exclude<T, GraphQLErrorResult>;
}

let internalErrors = 0;

/** How many unexpected exceptions this process has stored as `internal_error` (ruling 8). */
export function internalErrorCount(): number {
  return internalErrors;
}

/** Logs an unexpected exception after the claim and turns it into the stored `internal_error`. */
export function internalErrorFor(commandId: string, error: unknown): BusinessRejection {
  internalErrors += 1;
  const message = error instanceof Error ? error.message : String(error);
  Logger.error(`order.create ${commandId} failed unexpectedly: ${message}`, loggerCtx,
    error instanceof Error ? error.stack : undefined);
  return new BusinessRejection(INTERNAL_ERROR_CODE, 'The server could not record the order', { message });
}

// Postgres SQLSTATEs: 55P03 lock_not_available (the claim's lock_timeout), 40P01 deadlock_detected
// and 40001 serialization_failure; 57014 query_canceled (statement_timeout) and 25P03
// idle_in_transaction_session_timeout; class 08 connection exceptions except 08P01
// protocol_violation (deterministic), and 57P01–57P03 server shutdown or start-up. Node socket
// codes and the pg driver's uncoded connection messages are connection failures too.
const LOCK_CODES = new Set(['55P03', '40P01', '40001']);
const NODE_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const PG_CONNECTION_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i;

/** The transient kind of a thrown error, or undefined when it is not transient. */
export function transientKind(error: unknown): TransientKind | undefined {
  const driverError = (error as { driverError?: unknown })?.driverError ?? error;
  const code = (driverError as { code?: unknown })?.code;
  if (typeof code === 'string' && LOCK_CODES.has(code)) return 'lock';
  if (code === '57014' || code === '25P03') return 'timeout';
  if (typeof code === 'string' && ((/^08/.test(code) && code !== '08P01') || /^57P0[123]$/.test(code)
    || NODE_CONNECTION_CODES.has(code))) {
    return 'connection';
  }
  const message = (driverError as { message?: unknown })?.message;
  if (typeof message === 'string' && PG_CONNECTION_MESSAGES.test(message)) return 'connection';
  return undefined;
}

/** A Postgres unique violation (23505) on the named constraint. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const driverError = (error as { driverError?: { code?: unknown; constraint?: unknown } })?.driverError;
  return driverError?.code === '23505' && driverError.constraint === constraint;
}
