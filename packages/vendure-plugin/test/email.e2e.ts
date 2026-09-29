import { join } from 'node:path';
import { EventBus, OrderStateTransitionEvent, dummyPaymentHandler } from '@vendure/core';
import { EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import type { EmailDetails } from '@vendure/email-plugin';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyPosPlugin } from '../src';
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
  beforeAll(async () => {
    await environment.init();
    server.app.get(EventBus).ofType(OrderStateTransitionEvent).subscribe(event => {
      if (event.toState === 'PaymentSettled') settled.push(event.order.code);
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
    const { standardShippingId, dummyPaymentCode } = await createStorefrontMethods(adminClient);
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
});
