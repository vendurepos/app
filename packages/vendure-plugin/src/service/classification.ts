import { resolve, sep } from 'node:path';
import type { GraphQLErrorResult } from '@vendure/core';
import { BusinessRejection, ErrorResultThrown, PLATFORM_ERROR_CODE, StoreConfigurationRefusal, transientKind } from './errors';
import type { TransientKind } from './errors';

/**
 * Front desk ruling 1 and TallyUI ADR-038's `platform_error` amendment: how every failure after
 * the claim is answered, as origin × outcome. The sale's steps run in a savepoint, so every
 * outcome below starts from a sale that has been rolled back completely, claim kept. Ruling (A):
 * every deterministic refusal (unknown_variant, underpaid, the order limits as invalid_payload, the
 * permanent-list configuration as store_configuration) is answered before the claim and not stored,
 * so after the claim these rows are the safety net for races; their events leak (README).
 */
export const CLASSIFICATION = {
  rejection: 'stored', // the plugin's own refusal: unknown_variant, underpaid, idempotency_mismatch
  mapped: 'stored', // an ErrorResult with a contract code: insufficient_stock
  permanent: 'stored', // an ErrorResult on PERMANENT_ERROR_RESULTS: platform_error
  unlisted: 'transient', // any other ErrorResult: 503
  programming: 'stored', // the plugin's own TypeError, RangeError or ReferenceError: internal_error (before the claim: 503)
  storeConfiguration: 'notStored', // a refused PaymentSettled with a configuration cause: store_configuration
  // The unique tallyClientOrderId. This channel: the new id stored applied with the result of the order's
  // applied command; 409 while that command awaits an admin or is in progress. Another channel: idempotency_mismatch.
  clientOrderCollision: 'collision',
  database: 'transient', // driver, network, any SQLSTATE and anything else: 503 (409 only for the claim's lock)
} as const;

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
