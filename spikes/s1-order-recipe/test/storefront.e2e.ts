import { ConfigService, Order, Payment, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS1TestEnvironment } from './env';
import { createStorefrontMethods, guestOrder } from './shop';

describe('S1 proof 4: tally-pos and tally-in-store are closed to the Shop API', () => {
  const environment = createS1TestEnvironment({ paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] } });
  const { server, adminClient, shopClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let standardShippingId: string;
  let tallyShippingId: string;
  const outcomes: Record<string, unknown> = {};
  const decode = (id: string) => String(server.app.get(ConfigService).entityOptions.entityIdStrategy.decodeId(id));
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    ({ standardShippingId } = await createStorefrontMethods(adminClient));
    const { shippingMethods } = await adminClient.query<{ shippingMethods: { items: Array<{ id: string; code: string }> } }>(
      parse('query { shippingMethods { items { id code } } }'));
    tallyShippingId = shippingMethods.items.find(method => method.code === 'tally-in-store')!.id;
  });
  afterAll(async () => {
    console.log('S1-NUM', JSON.stringify({ proof: 4, ...outcomes }));
    await server.destroy();
  });

  it('a Shop API guest sees tally-pos ineligible, cannot pick tally-in-store and cannot settle with tally-pos', async () => {
    const shop = await guestOrder(shopClient, variantIds.mug[0], 's1-shop-4@example.com');
    expect(shop.added.state).toBe('AddingItems');
    const { eligiblePaymentMethods, eligibleShippingMethods } = await shop.eligible();
    const tallyPayment = eligiblePaymentMethods.find(method => method.code === 'tally-pos');
    expect(tallyPayment === undefined || tallyPayment.isEligible === false).toBe(true);
    expect(eligibleShippingMethods.map(method => method.code)).not.toContain('tally-in-store');
    const setTally = await shop.setShipping(tallyShippingId);
    expect(setTally.errorCode).toBe('INELIGIBLE_SHIPPING_METHOD_ERROR');
    expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
    expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
    const paid = await shop.pay('tally-pos');
    expect(paid.errorCode).toBe('INELIGIBLE_PAYMENT_METHOD_ERROR');
    const after = await shop.active();
    expect(after.state).toBe('ArrangingPayment');
    expect(after.payments).toEqual([]);
    Object.assign(outcomes, {
      eligiblePayment: tallyPayment ?? 'absent',
      eligibleShipping: eligibleShippingMethods.map(method => method.code),
      setOrderShippingMethod: setTally.errorCode, addPaymentToOrder: paid.errorCode,
      stateAfterPay: after.state, payments: after.payments.length,
    });
  });

  it('the handler guard alone: a Shop API order carrying tallyClientOrderId still cannot settle with tally-pos', async () => {
    const shop = await guestOrder(shopClient, variantIds.mug[0], 's1-shop-4b@example.com');
    expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
    const arranged = await shop.arrangePayment();
    expect(arranged.state).toBe('ArrangingPayment');
    // Test-only: set the POS marker directly, so the eligibility checker passes and only the handler guards.
    await connection.rawConnection.getRepository(Order).update(decode(arranged.id!), {
      customFields: { tallyClientOrderId: 's1-forged-client-order-id' },
    });
    const { eligiblePaymentMethods } = await shop.eligible();
    const tallyPayment = eligiblePaymentMethods.find(method => method.code === 'tally-pos');
    expect(tallyPayment?.isEligible).toBe(true);
    const paid = await shop.pay('tally-pos') as { errorCode?: string; paymentErrorMessage?: string };
    expect(paid.errorCode).toBe('PAYMENT_DECLINED_ERROR');
    const after = await shop.active();
    expect(after.state).toBe('ArrangingPayment');
    const payments = await connection.rawConnection.getRepository(Payment).find({
      where: { order: { id: decode(arranged.id!) } },
    });
    expect(payments.map(payment => [payment.method, payment.state])).toEqual([['tally-pos', 'Declined']]);
    Object.assign(outcomes, { guard: {
      eligibleWithForgedId: tallyPayment?.isEligible, addPaymentToOrder: paid.errorCode,
      message: paid.paymentErrorMessage, stateAfterPay: after.state,
      payments: payments.map(payment => `${payment.method}:${payment.state}`),
    } });
  });
});
