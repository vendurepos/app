import {
  CreateFulfillmentError, EmptyOrderLineSelectionError, FulfillmentStateTransitionError,
  IneligibleShippingMethodError, InsufficientStockError, InvalidFulfillmentHandlerError, ItemsAlreadyFulfilledError,
  NegativeQuantityError, OrderInterceptorError, OrderLimitError, OrderModificationError, OrderStateTransitionError,
} from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION, MAPPED_ERROR_RESULTS, PERMANENT_ERROR_RESULTS } from '../src';
import { classify } from '../src/service/classification';
import { BusinessRejection, ErrorResultThrown, PluginBugError, StoreConfigurationRefusal, pluginBug } from '../src/service/errors';
import { commandFingerprint } from '../src/vendored/fingerprint';

// Front desk ruling 1: one test per row of the origin × outcome table in src/service/classification.ts.
describe('error classification (ruling 1, the platform_error amendment)', () => {
  const INDEX = 'UQ_client_order';
  const thrown = (result: object) => new ErrorResultThrown(result as GraphQLErrorResult);
  const raise = (work: () => unknown) => {
    try {
      work();
    } catch (error) {
      return error;
    }
    throw new Error('expected a throw');
  };
  it('is the table the ADR states', () => {
    expect(CLASSIFICATION).toEqual({
      rejection: 'transient', mapped: 'transient', permanent: 'transient', unlisted: 'transient', programming: 'needsAdmin',
      storeConfiguration: 'notStored', clientOrderCollision: 'collision', database: 'transient',
    });
  });

  it('rejection, re-ruling 3: a race on the plugin\'s own checks inside the recipe is transient, never stored', () => {
    for (const code of ['unknown_variant', 'underpaid']) {
      expect(classify(new BusinessRejection(code, 'refused'), INDEX)).toEqual({ origin: 'rejection', outcome: 'transient', kind: 'unclassified' });
    }
  });

  it('mapped, re-ruling 3: a stock race inside the recipe is transient, never a stored insufficient_stock', () => {
    expect(MAPPED_ERROR_RESULTS).toEqual({ INSUFFICIENT_STOCK_ERROR: 'insufficient_stock', INSUFFICIENT_STOCK_ON_HAND_ERROR: 'insufficient_stock' });
    expect(classify(thrown(new InsufficientStockError({ quantityAvailable: 2, order: undefined as never })), INDEX)).toEqual({
      origin: 'mapped', outcome: 'transient', kind: 'unclassified',
    });
  });

  it('permanent, re-ruling 3: every listed ErrorResult met inside the recipe is a configuration race, transient', () => {
    const samples: GraphQLErrorResult[] = [
      new OrderLimitError({ maxItems: 1 }), new NegativeQuantityError(), new EmptyOrderLineSelectionError(),
      new InvalidFulfillmentHandlerError(), new IneligibleShippingMethodError(),
      // A shop-API ErrorResult that @vendure/core does not export, as PaymentService.createPayment returns it.
      { __typename: 'IneligiblePaymentMethodError', errorCode: 'INELIGIBLE_PAYMENT_METHOD_ERROR', message: 'INELIGIBLE_PAYMENT_METHOD_ERROR' } as GraphQLErrorResult,
    ];
    expect(samples.map(sample => sample.errorCode).sort()).toEqual(Object.keys(PERMANENT_ERROR_RESULTS).sort());
    for (const sample of samples) {
      expect(classify(thrown(sample), INDEX), sample.errorCode).toEqual({ origin: 'permanent', outcome: 'transient', kind: 'unclassified' });
    }
  });

  it('unlisted: state-dependent and merchant-code ErrorResults are transient', () => {
    const samples: GraphQLErrorResult[] = [
      new OrderStateTransitionError({ transitionError: 'no', fromState: 'ArrangingPayment', toState: 'PaymentSettled' }),
      new FulfillmentStateTransitionError({ transitionError: 'no', fromState: 'Pending', toState: 'Delivered' }),
      new OrderModificationError(), new ItemsAlreadyFulfilledError(), new OrderInterceptorError({ interceptorError: 'no' }),
      new CreateFulfillmentError({ fulfillmentHandlerError: 'no' }),
      { __typename: 'SomeFutureError', errorCode: 'SOME_FUTURE_ERROR', message: 'SOME_FUTURE_ERROR' } as GraphQLErrorResult,
    ];
    for (const sample of samples) {
      expect(PERMANENT_ERROR_RESULTS[sample.errorCode], sample.errorCode).toBeUndefined();
      expect(classify(thrown(sample), INDEX), sample.errorCode).toEqual({ origin: 'unlisted', outcome: 'transient', kind: 'unclassified' });
    }
  });

  it('programming (N5): only an explicit PluginBugError is kept for an admin; any native error, the plugin\'s own included, is transient', () => {
    const bug = raise(() => pluginBug('invariant broke'));
    expect(bug).toBeInstanceOf(PluginBugError);
    expect(classify(bug, INDEX)).toEqual({ origin: 'programming', outcome: 'needsAdmin' });
    const own = raise(() => commandFingerprint(null as never)); // A TypeError inside the plugin's own module.
    for (const error of [own, raise(() => new URL('not a url')), new TypeError('test'), new RangeError('test'), new Error('x')]) {
      expect(classify(error, INDEX), String(error)).toEqual({ origin: 'database', outcome: 'transient', kind: 'unclassified' });
    }
  });

  it('storeConfiguration: a configuration refusal after the claim is answered but not stored', () => {
    expect(classify(new StoreConfigurationRefusal(), INDEX)).toEqual({ origin: 'storeConfiguration', outcome: 'notStored' });
  });

  it('clientOrderCollision: only a unique violation on the tallyClientOrderId index', () => {
    expect(classify({ driverError: { code: '23505', constraint: INDEX } }, INDEX)).toEqual({ origin: 'clientOrderCollision', outcome: 'collision' });
    expect(classify({ driverError: { code: '23505', constraint: 'another' } }, INDEX)).toMatchObject({ origin: 'database', kind: 'unclassified' });
  });

  it('database: driver, network and unknown-SQLSTATE errors are transient with their kind', () => {
    const driver = (code: string) => ({ driverError: { code } });
    expect(classify(driver('55P03'), INDEX)).toEqual({ origin: 'database', outcome: 'transient', kind: 'lock' });
    expect(classify(driver('40P01'), INDEX)).toMatchObject({ outcome: 'transient', kind: 'deadlock' });
    expect(classify(Object.assign(new Error('socket'), { code: 'ECONNRESET' }), INDEX)).toMatchObject({ outcome: 'transient', kind: 'connection' });
    for (const code of ['22012', '42P01', '23503', 'XX000']) {
      expect(classify(driver(code), INDEX), code).toEqual({ origin: 'database', outcome: 'transient', kind: 'unclassified' });
    }
  });
});
