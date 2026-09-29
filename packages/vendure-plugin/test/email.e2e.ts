import { join } from 'node:path';
import { ConfigService, EventBus, Order, OrderStateTransitionEvent, TransactionalConnection, dummyPaymentHandler } from '@vendure/core';
import { EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import type { EmailDetails } from '@vendure/email-plugin';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderCreateService, TallyPosPlugin } from '../src';
import { tallyOrderConfirmationHandler } from '../src/email';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

const sent: EmailDetails[] = [];

// The testing transport only; a real transport is a later e2e (ADR 0002 follow-ups).
describe('proof 3: the exported tallyOrderConfirmationHandler skips POS orders and still emails a storefront order', () => {
  const environment = createPluginTestEnvironment({
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
    plugins: [TallyPosPlugin, EmailPlugin.init({
      handlers: [tallyOrderConfirmationHandler],
      templateLoader: new FileBasedTemplateLoader(
        join(__dirname, '../node_modules/@vendure/email-plugin/templates')),
      transport: { type: 'testing', onSend: details => sent.push(details) },
      globalTemplateVars: { fromAddress: '"VP1" <vp1@vendurepos.invalid>' },
    })],
  });
  const { server, adminClient, shopClient, variantIds, run } = environment;
  // The confirmation handler's event (S1 finding 6), so the POS count of 0 cannot pass vacuously.
  const settled: string[] = [];
  let storefront: Awaited<ReturnType<typeof createStorefrontMethods>> | undefined;
  beforeAll(async () => {
    await environment.init();
    server.app.get(EventBus).ofType(OrderStateTransitionEvent).subscribe(event => {
      if (event.toState === 'PaymentSettled') settled.push(event.order.code, event.order.customFields.tallyClientOrderId ?? '');
    });
  });
  afterAll(() => server.destroy());

  async function drainJobs() {
    const start = performance.now();
    while (performance.now() - start < 20_000) {
      const { jobs } = await adminClient.query<{ jobs: { items: Array<{ state: string }> } }>(
        parse('query { jobs { items { state } } }'));
      if (!jobs.items.some(job => job.state === 'PENDING' || job.state === 'RUNNING') && sent.length) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Job queue did not drain with an email sent (${sent.length} sent)`);
  }

  it('sends no confirmation for the POS order and one for the Shop API guest', async () => {
    const { standardShippingId, dummyPaymentCode } = storefront ??= await createStorefrontMethods(adminClient);
    const posEmail = 'vp1-pos-buyer@example.com';
    const controlEmail = 'vp1-shop-buyer@example.com';
    const pos = await run(orderCommand(
      [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: posEmail },
    ));
    expect(pos, JSON.stringify(pos)).toMatchObject({ status: 'applied' });

    const shop = await guestOrder(shopClient, variantIds.mug[0], controlEmail);
    expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
    expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
    expect((await shop.pay(dummyPaymentCode)).state).toBe('PaymentSettled');

    await drainJobs();
    expect(settled).toContain(pos.serverRefs!.displayId);
    expect(sent.filter(email => email.recipient === posEmail)).toHaveLength(0);
    expect(sent.filter(email => email.recipient === controlEmail)).toHaveLength(1);
  });

  it('ruling (A): an after-claim race rejection leaks the PaymentSettled event of an order that does not exist; the handler ignores it', async () => {
    const raceEmail = 'vp2-race-buyer@example.com';
    const controlEmail = 'vp2-shop-buyer@example.com';
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: raceEmail });
    const recipe = server.app.get(OrderCreateService);
    const shippingOptions = server.app.get(ConfigService).shippingOptions;
    const handlers = shippingOptions.fulfillmentHandlers;
    // A configuration race after the pre-claim check: createFulfillment refuses after PaymentSettled.
    recipe.testObserver = async (stage, _ctx, order) => {
      if (stage !== 'payments' || order.customFields.tallyClientOrderId !== input.payload.clientOrderId) return;
      shippingOptions.fulfillmentHandlers = handlers.filter(handler => handler.code !== 'manual-fulfillment');
    };
    try {
      expect(await run(input)).toMatchObject({ status: 'rejected', error: { code: 'platform_error' } });
    } finally {
      shippingOptions.fulfillmentHandlers = handlers;
      recipe.testObserver = undefined;
    }
    const start = performance.now();
    while (!settled.includes(input.payload.clientOrderId) && performance.now() - start < 5000) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // The leak itself: the event arrived, but its order does not exist.
    expect(settled).toContain(input.payload.clientOrderId);
    expect(await server.app.get(TransactionalConnection).rawConnection.getRepository(Order).count({
      where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
    })).toBe(0);
    // A Shop API sale afterwards is emailed, so the queue is working while the leaked event sends nothing.
    const { standardShippingId, dummyPaymentCode } = storefront ??= await createStorefrontMethods(adminClient);
    const shop = await guestOrder(shopClient, variantIds.mug[0], controlEmail);
    await shop.setShipping(standardShippingId);
    await shop.arrangePayment();
    expect((await shop.pay(dummyPaymentCode)).state).toBe('PaymentSettled');
    while (!sent.some(email => email.recipient === controlEmail) && performance.now() - start < 20_000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(sent.filter(email => email.recipient === controlEmail)).toHaveLength(1);
    expect(sent.filter(email => email.recipient === raceEmail)).toHaveLength(0);
  });
});
