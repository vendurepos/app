import { resolve, sep } from 'node:path';
import type { GraphQLErrorResult } from '@vendure/core';
import { BusinessRejection, ErrorResultThrown, PLATFORM_ERROR_CODE, StoreConfigurationRefusal, transientKind } from './errors';
import type { TransientKind } from './errors';

/**
 * Front desk ruling 1 and TallyUI ADR-038's `platform_error` amendment: how every failure after
 * the claim is answered, as origin × outcome. The sale's steps run in a savepoint, so every
 * outcome below starts from a sale that has been rolled back completely, claim kept.
 *
 * | Origin                                                        | Outcome                                          |
 * |---------------------------------------------------------------|--------------------------------------------------|
 * | `rejection`: the plugin's own business refusal                | stored, its contract code (`unknown_variant`, `underpaid`, `idempotency_mismatch`) |
 * | `mapped`: an ErrorResult with a contract code                 | stored, that code (`insufficient_stock`)          |
 * | `permanent`: an ErrorResult on PERMANENT_ERROR_RESULTS        | stored `platform_error`                           |
 * | `unlisted`: any other ErrorResult                             | transient 503, nothing stored                     |
 * | `programming`: a TypeError, RangeError or ReferenceError raised by plugin code after the claim (before it: transient) | stored `internal_error`, generic message and a correlation id |
 * | `storeConfiguration`: a refused PaymentSettled with a configuration cause | `store_configuration`, nothing stored   |
 * | `clientOrderCollision`: the unique `tallyClientOrderId`        | this channel: the new id stored `applied` with the refs and warnings when the order's own command is `applied`; 409 when that command awaits an admin or is still in progress (the unique key's wait, bounded like the claim's). Another channel: stored `idempotency_mismatch` |
 * | `database`: a driver, network or database error, known SQLSTATE or not, and anything else | transient (503; 409 only for the claim's own lock) |
 */
export type Origin = 'rejection' | 'mapped' | 'permanent' | 'unlisted' | 'programming' | 'storeConfiguration'
  | 'clientOrderCollision' | 'database';

export type Outcome = 'stored' | 'transient' | 'notStored' | 'collision';

export const CLASSIFICATION: Record<Origin, Outcome> = {
  rejection: 'stored',
  mapped: 'stored',
  permanent: 'stored',
  unlisted: 'transient',
  programming: 'stored',
  storeConfiguration: 'notStored',
  clientOrderCollision: 'collision',
  database: 'transient',
};

/** ErrorResults with a contract code of their own. A shortage createFulfillment finds is the same answer as one addItemToOrder finds (ruling 3). */
export const MAPPED_ERROR_RESULTS: Record<string, string> = {
  INSUFFICIENT_STOCK_ERROR: 'insufficient_stock',
  INSUFFICIENT_STOCK_ON_HAND_ERROR: 'insufficient_stock',
};

/**
 * The permanent list (Vendure 3.7.3): ErrorResults that the recipe's own calls can return and that
 * depend only on the payload and the store's configuration, so a replay fails the same way until
 * the configuration changes. Every other ErrorResult is transient. Left off on purpose:
 * ORDER_STATE_TRANSITION_ERROR and FULFILLMENT_STATE_TRANSITION_ERROR (a state transition; the
 * order process may consult anything), ORDER_MODIFICATION_ERROR and ITEMS_ALREADY_FULFILLED_ERROR
 * (the order's state), ORDER_INTERCEPTOR_ERROR (a merchant's interceptor, which may read stock or
 * time), CREATE_FULFILLMENT_ERROR (a fulfilment handler threw, perhaps on a network call), and
 * EMAIL_ADDRESS_CONFLICT_ERROR (unreachable: createOrUpdate is called without errorOnExistingUser).
 */
export const PERMANENT_ERROR_RESULTS: Record<string, string> = {
  // OrderService.addItemToOrder: the quantity exceeds orderOptions.orderItemsLimit or orderLineItemsLimit.
  ORDER_LIMIT_ERROR: 'the payload exceeds a configured order limit',
  // OrderService.addItemToOrder: a negative quantity, fixed by the payload (shape validation already refuses it).
  NEGATIVE_QUANTITY_ERROR: 'the payload carries a negative quantity',
  // OrderService.createFulfillment: every line quantity is zero, fixed by the payload.
  EMPTY_ORDER_LINE_SELECTION_ERROR: 'the payload fulfils no quantity',
  // FulfillmentService.create: the manual fulfilment handler is not in shippingOptions.fulfillmentHandlers.
  INVALID_FULFILLMENT_HANDLER_ERROR: 'the configuration lacks the manual fulfilment handler',
  // OrderService.setShippingMethod: tally-in-store's checker refused; the plugin's checker is a pure function of the order.
  INELIGIBLE_SHIPPING_METHOD_ERROR: 'the in-store shipping method\'s checker refuses this order',
  // PaymentService.createPayment: tally-pos's checker refused; the plugin's checker is a pure function of the order.
  INELIGIBLE_PAYMENT_METHOD_ERROR: 'the POS payment method\'s checker refuses this order',
};

// src/ or dist/, whichever this module was loaded from.
const PLUGIN_DIR = resolve(__dirname, '..');

/**
 * True when a TypeError, RangeError or ReferenceError was raised by a frame in the plugin's own
 * modules (`pluginDir`, which itself sits in node_modules once installed), not by Vendure, the
 * database client or any other package.
 */
export function isPluginProgrammingError(error: unknown, pluginDir = PLUGIN_DIR): boolean {
  if (!(error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError)) return false;
  if ((error as { driverError?: unknown }).driverError !== undefined) return false;
  const frame = error.stack?.split('\n').find(line => line.trimStart().startsWith('at '));
  const file = frame?.match(/\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/)?.[1]?.replace(/^file:\/\//, '');
  return !!file && file.startsWith(pluginDir + sep) && !file.slice(pluginDir.length).includes(`${sep}node_modules${sep}`);
}

export type Classification =
  | { origin: 'rejection' | 'mapped' | 'permanent' | 'programming'; outcome: 'stored'; rejection?: BusinessRejection }
  | { origin: 'unlisted' | 'database'; outcome: 'transient'; kind: TransientKind }
  | { origin: 'storeConfiguration'; outcome: 'notStored' }
  | { origin: 'clientOrderCollision'; outcome: 'collision' };

/** Classifies an error raised by the sale's steps. `clientOrderIndex` names the unique index on tallyClientOrderId. */
export function classify(error: unknown, clientOrderIndex: string): Classification {
  if (error instanceof BusinessRejection) return { origin: 'rejection', outcome: 'stored', rejection: error };
  if (error instanceof StoreConfigurationRefusal) return { origin: 'storeConfiguration', outcome: 'notStored' };
  if (error instanceof ErrorResultThrown) {
    const { errorCode, message, __typename, ...fields } = error.result as GraphQLErrorResult & Record<string, unknown>;
    // Outside GraphQL an ErrorResult's message is its untranslated key; its specifics are separate fields.
    const details = Object.fromEntries(Object.entries(fields).filter(([, value]) => value === null || typeof value !== 'object'));
    const readable = Object.keys(details).length ? `${message}: ${JSON.stringify(details)}` : message;
    const mapped = MAPPED_ERROR_RESULTS[errorCode];
    if (mapped) return { origin: 'mapped', outcome: 'stored', rejection: new BusinessRejection(mapped, readable) };
    if (PERMANENT_ERROR_RESULTS[errorCode]) {
      return { origin: 'permanent', outcome: 'stored', rejection: new BusinessRejection(PLATFORM_ERROR_CODE,
        `${errorCode}: ${readable}`, { platformCode: errorCode, platformMessage: readable }) };
    }
    return { origin: 'unlisted', outcome: 'transient', kind: 'unclassified' };
  }
  const driverError = (error as { driverError?: { code?: unknown; constraint?: unknown } })?.driverError;
  if (driverError?.code === '23505' && driverError.constraint === clientOrderIndex) {
    return { origin: 'clientOrderCollision', outcome: 'collision' };
  }
  if (isPluginProgrammingError(error)) return { origin: 'programming', outcome: 'stored' };
  return { origin: 'database', outcome: 'transient', kind: transientKind(error) ?? 'unclassified' };
}
