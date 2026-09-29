import { isGraphQlErrorResult } from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';

/**
 * The contract code for an ErrorResult the plugin does not map (ADR 0002 §2 "any other
 * ErrorResult"): a stored rejection that carries Vendure's own code and message in `data`.
 */
export const UNKNOWN_REJECTION_CODE = 'vendure_error';

/** A business refusal found after the claim: the order rolls back and the rejection is stored. */
export class BusinessRejection extends Error {
  constructor(readonly code: string, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

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
// PaymentSettled transition is refused, because it depends on the payments.
const KNOWN_ERROR_RESULTS: Record<string, string> = {
  INSUFFICIENT_STOCK_ERROR: 'insufficient_stock',
};

export function rejectionFor(error: GraphQLErrorResult): BusinessRejection {
  const known = KNOWN_ERROR_RESULTS[error.errorCode];
  if (known) return new BusinessRejection(known, error.message);
  return new BusinessRejection(UNKNOWN_REJECTION_CODE, error.message, {
    vendureCode: error.errorCode, vendureMessage: error.message,
  });
}

/** ADR 0002 §2 "Error results become throws": a returned ErrorResult rolls the order back. */
export function unwrap<T>(result: T): Exclude<T, GraphQLErrorResult> {
  if (isGraphQlErrorResult(result)) throw rejectionFor(result as GraphQLErrorResult);
  return result as Exclude<T, GraphQLErrorResult>;
}

// Postgres SQLSTATEs: 55P03 lock_not_available (the claim's lock_timeout); 57014 query_canceled
// (statement_timeout) and 25P03 idle_in_transaction_session_timeout; class 08 connection
// exceptions and 57P01–57P03 server shutdown or start-up. Node socket codes and the pg driver's
// uncoded connection messages are connection failures too.
const NODE_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const PG_CONNECTION_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i;

/** The transient kind of a thrown error, or undefined when it is not transient. */
export function transientKind(error: unknown): TransientKind | undefined {
  const driverError = (error as { driverError?: unknown })?.driverError ?? error;
  const code = (driverError as { code?: unknown })?.code;
  if (code === '55P03') return 'lock';
  if (code === '57014' || code === '25P03') return 'timeout';
  if (typeof code === 'string' && (/^08/.test(code) || /^57P0[123]$/.test(code) || NODE_CONNECTION_CODES.has(code))) {
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
