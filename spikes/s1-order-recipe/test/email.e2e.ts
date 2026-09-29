import { fileURLToPath } from 'node:url';
import { ConfigService, OrderStateTransitionEvent, dummyPaymentHandler } from '@vendure/core';
import { EmailPlugin, FileBasedTemplateLoader, orderConfirmationHandler } from '@vendure/email-plugin';
import type { EmailDetails } from '@vendure/email-plugin';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/vendored/commands';
import { TallySpikePlugin } from '../src/plugin/tally-spike.plugin';
import { createS1TestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

const sent: EmailDetails[] = [];
// Every PaymentSettled confirmation event that reaches the POS filter, with its verdict.
const filtered: Array<{ code: string; tallyClientOrderId: string | null | undefined; send: boolean }> = [];
// ADR 0002 "No customer email": the configured handler filters on tallyClientOrderId.
const posAwareConfirmation = orderConfirmationHandler.filter(event => {
  const send = !event.order.customFields.tallyClientOrderId;
  filtered.push({ code: event.order.code, tallyClientOrderId: event.order.customFields.tallyClientOrderId ?? null, send });
  return send;
});

describe('S1 proof 3: a POS order sends no order confirmation; a storefront order does', () => {
  const environment = createS1TestEnvironment({
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
    plugins: [TallySpikePlugin, EmailPlugin.init({
      handlers: [posAwareConfirmation],
      templateLoader: new FileBasedTemplateLoader(
        fileURLToPath(new URL('../node_modules/@vendure/email-plugin/templates', import.meta.url))),
      transport: { type: 'testing', onSend: details => sent.push(details) },
      globalTemplateVars: { fromAddress: '"S1" <s1@vendurepos.invalid>' },
    })],
  });
  const { server, adminClient, shopClient, variantIds } = environment;
  beforeAll(() => environment.init());
  afterAll(() => server.destroy());

  async function drainJobs() {
    const start = performance.now();
    while (performance.now() - start < 20_000) {
      const { jobs } = await adminClient.query<{ jobs: { items: Array<{ queueName: string; state: string }> } }>(
        parse('query { jobs { items { queueName state } } }'));
      const busy = jobs.items.filter(job => job.state === 'PENDING' || job.state === 'RUNNING');
      if (!busy.length && sent.length) return jobs.items;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Job queue did not drain with an email sent (${sent.length} sent)`);
  }

  it('filters the POS order out of orderConfirmationHandler and still emails the Shop API guest', async () => {
    const { standardShippingId, dummyPaymentCode } = await createStorefrontMethods(adminClient);
    const strategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
    const posEmail = 's1-pos-buyer@example.com';
    const controlEmail = 's1-shop-buyer@example.com';
    const command = orderCommand(
      [{ variantId: String(strategy.decodeId(variantIds.mug[0])), quantity: 1, unitPriceMinor: 800 }],
      undefined, { email: posEmail },
    );
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Tally-Protocol': '1',
        Authorization: `Bearer ${adminClient.getAuthToken()}`,
      },
      body: JSON.stringify({ commands: [command] }),
    });
    const pos = (await response.json() as { results: CommandResult[] }).results[0];
    expect(pos, JSON.stringify(pos)).toMatchObject({ status: 'applied' });

    const shop = await guestOrder(shopClient, variantIds.mug[0], controlEmail);
    expect((await shop.setShipping(standardShippingId)).state).toBe('AddingItems');
    expect((await shop.arrangePayment()).state).toBe('ArrangingPayment');
    const control = await shop.pay(dummyPaymentCode);
    expect(control.state).toBe('PaymentSettled');

    const jobs = await drainJobs();
    const posEmails = sent.filter(email => email.recipient === posEmail).length;
    const controlEmails = sent.filter(email => email.recipient === controlEmail).length;
    console.log('S1-NUM', JSON.stringify({
      proof: 3, posEmails, controlEmails, event: OrderStateTransitionEvent.name, filtered,
      subjects: sent.map(email => email.subject), jobs: jobs.map(job => `${job.queueName}:${job.state}`),
    }));
    expect(filtered).toEqual([
      { code: pos.serverRefs!.displayId, tallyClientOrderId: command.payload.clientOrderId, send: false },
      { code: control.code, tallyClientOrderId: null, send: true },
    ]);
    expect(posEmails).toBe(0);
    expect(controlEmails).toBe(1);
  });
});
