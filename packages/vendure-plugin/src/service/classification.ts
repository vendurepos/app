import type { GraphQLErrorResult } from '@vendure/core';
import { BusinessRejection, ErrorResultThrown, PluginBugError, StoreConfigurationRefusal, transientKind } from './errors';
import type { TransientKind } from './errors';

/**
 * Front desk ruling 1, TallyUI ADR-038's `platform_error` amendment and the re-rulings: how every
 * failure of the recipe is answered, as origin × outcome. The deterministic refusals (variant,
 * limits, underpaid, configuration, values, currency) are checked after the claim and before the
 * recipe's first write, and stored on the claim. The recipe publishes its first event at its first
 * write, so none of its errors becomes a stored rejection (its events would outlive it): each
 * rolls everything back, events included, unless part of the sale must stay for an admin.
 */
export const CLASSIFICATION = {
  rejection: 'transient', // a race on the plugin's own checks (unknown_variant, underpaid): the retry's checks answer it
  mapped: 'transient', // a stock race (insufficient_stock despite the top-up): the retry tops up again
  permanent: 'transient', // a configuration race on PERMANENT_ERROR_RESULTS: the retry's checks answer it
  unlisted: 'transient', // any other ErrorResult: 503
  programming: 'needsAdmin', // a PluginBugError with part of the sale written (before any write: 503)
  storeConfiguration: 'notStored', // a declined payment or a refused PaymentSettled with a configuration cause
  // The unique tallyClientOrderId, met after the first event: roll back and run the command again, so that the
  // collision guard answers it before any write (applied, 409, or another channel's idempotency_mismatch).
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


export type Classification =
  | { origin: 'rejection' | 'mapped' | 'permanent' | 'unlisted' | 'database'; outcome: 'transient'; kind: TransientKind }
  | { origin: 'programming'; outcome: 'needsAdmin' }
  | { origin: 'storeConfiguration'; outcome: 'notStored' }
  | { origin: 'clientOrderCollision'; outcome: 'collision' };

/** Classifies an error raised by the recipe. `clientOrderIndex` names the unique index on tallyClientOrderId. */
export function classify(error: unknown, clientOrderIndex: string): Classification {
  if (error instanceof BusinessRejection) return { origin: 'rejection', outcome: 'transient', kind: 'unclassified' };
  if (error instanceof StoreConfigurationRefusal) return { origin: 'storeConfiguration', outcome: 'notStored' };
  if (error instanceof ErrorResultThrown) {
    const { errorCode } = error.result as GraphQLErrorResult;
    const origin = MAPPED_ERROR_RESULTS[errorCode] ? 'mapped' : PERMANENT_ERROR_RESULTS[errorCode] ? 'permanent' : 'unlisted';
    return { origin, outcome: 'transient', kind: 'unclassified' };
  }
  const driverError = (error as { driverError?: { code?: unknown; constraint?: unknown } })?.driverError;
  if (driverError?.code === '23505' && driverError.constraint === clientOrderIndex) {
    return { origin: 'clientOrderCollision', outcome: 'collision' };
  }
  if (error instanceof PluginBugError) return { origin: 'programming', outcome: 'needsAdmin' };
  return { origin: 'database', outcome: 'transient', kind: transientKind(error) ?? 'unclassified' };
}
