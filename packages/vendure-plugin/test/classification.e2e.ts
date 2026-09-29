import {
  CreateFulfillmentError, EmptyOrderLineSelectionError, FulfillmentStateTransitionError,
  IneligibleShippingMethodError, InsufficientStockError, InvalidFulfillmentHandlerError, ItemsAlreadyFulfilledError,
  NegativeQuantityError, OrderInterceptorError, OrderLimitError, OrderModificationError, OrderStateTransitionError,
} from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION, MAPPED_ERROR_RESULTS, PERMANENT_ERROR_RESULTS } from '../src';
import { classify, isPluginProgrammingError } from '../src/service/classification';
import { BusinessRejection, ErrorResultThrown, StoreConfigurationRefusal } from '../src/service/errors';
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
      rejection: 'stored', mapped: 'stored', permanent: 'stored', unlisted: 'transient', programming: 'stored',
      storeConfiguration: 'notStored', clientOrderCollision: 'collision', database: 'transient',
    });
  });

  it('rejection: the plugin\'s own business refusal is stored with its contract code', () => {
    for (const code of ['unknown_variant', 'underpaid']) {
      const rejection = new BusinessRejection(code, 'refused');
      expect(classify(rejection, INDEX)).toEqual({ origin: 'rejection', outcome: 'stored', rejection });
    }
  });

  it('mapped: a stock ErrorResult is stored as insufficient_stock', () => {
    expect(MAPPED_ERROR_RESULTS).toEqual({ INSUFFICIENT_STOCK_ERROR: 'insufficient_stock', INSUFFICIENT_STOCK_ON_HAND_ERROR: 'insufficient_stock' });
    expect(classify(thrown(new InsufficientStockError({ quantityAvailable: 2, order: undefined as never })), INDEX)).toMatchObject({
      origin: 'mapped', outcome: 'stored', rejection: { code: 'insufficient_stock' },
    });
  });

  it('permanent: every listed ErrorResult is a stored platform_error in platformErrorResult\'s shape', () => {
    const samples: GraphQLErrorResult[] = [
      new OrderLimitError({ maxItems: 1 }), new NegativeQuantityError(), new EmptyOrderLineSelectionError(),
      new InvalidFulfillmentHandlerError(), new IneligibleShippingMethodError(),
      // A shop-API ErrorResult that @vendure/core does not export, as PaymentService.createPayment returns it.
      { __typename: 'IneligiblePaymentMethodError', errorCode: 'INELIGIBLE_PAYMENT_METHOD_ERROR', message: 'INELIGIBLE_PAYMENT_METHOD_ERROR' } as GraphQLErrorResult,
    ];
    expect(samples.map(sample => sample.errorCode).sort()).toEqual(Object.keys(PERMANENT_ERROR_RESULTS).sort());
    for (const sample of samples) {
      const verdict = classify(thrown(sample), INDEX);
      expect(verdict, sample.errorCode).toMatchObject({ origin: 'permanent', outcome: 'stored' });
      const { code, message, data } = (verdict as { rejection: BusinessRejection }).rejection;
      expect(code).toBe('platform_error');
      expect(data).toEqual({ platformCode: sample.errorCode, platformMessage: expect.any(String) });
      expect(message).toBe(`${data!.platformCode}: ${data!.platformMessage}`);
    }
    expect((classify(thrown(new OrderLimitError({ maxItems: 1 })), INDEX) as { rejection: BusinessRejection }).rejection.data)
      .toEqual({ platformCode: 'ORDER_LIMIT_ERROR', platformMessage: 'ORDER_LIMIT_ERROR: {"maxItems":1}' });
  });

  it('unlisted: state-dependent and merchant-code ErrorResults are transient, never platform_error', () => {
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

  it('programming: only a TypeError, RangeError or ReferenceError raised in the plugin\'s own code is stored internal_error', () => {
    const own = raise(() => commandFingerprint(null as never));
    expect(own).toBeInstanceOf(TypeError);
    expect(isPluginProgrammingError(own)).toBe(true);
    expect(classify(own, INDEX)).toEqual({ origin: 'programming', outcome: 'stored' });
    // Raised by Node, by this test file, or not one of the three types: transient.
    for (const error of [raise(() => new URL('not a url')), new TypeError('test'), new RangeError('test'), new SyntaxError('x'), new Error('x')]) {
      expect(isPluginProgrammingError(error), String(error)).toBe(false);
      expect(classify(error, INDEX), String(error)).toEqual({ origin: 'database', outcome: 'transient', kind: 'unclassified' });
    }
    // Installed, the plugin itself lives under node_modules; only a package nested below it is foreign.
    const installed = '/app/node_modules/@vendurepos/plugin/dist';
    const at = (file: string) => Object.assign(new TypeError('x'), { stack: `TypeError: x\n    at recipe (${file}:12:34)\n    at next (/app/y.js:1:1)` });
    expect(isPluginProgrammingError(at(`${installed}/service/order-create.service.js`), installed)).toBe(true);
    expect(isPluginProgrammingError(at(`${installed}/node_modules/dep/index.js`), installed)).toBe(false);
    expect(isPluginProgrammingError(at('/app/node_modules/@vendure/core/dist/service/order.service.js'), installed)).toBe(false);
    expect(isPluginProgrammingError(at('/app/node_modules/pg/lib/client.js'), installed)).toBe(false);
    // A driver error that happens to be a TypeError is never a programming error.
    expect(isPluginProgrammingError(Object.assign(raise(() => commandFingerprint(null as never)) as object, { driverError: {} }))).toBe(false);
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
