import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EventBus, OrderStateTransitionEvent, dummyPaymentHandler } from '@vendure/core';
import { EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
// The package's own export (dist/, so `npm run build` first), as a store installs it.
import { tallyOrderConfirmationHandler } from '@vendurepos/plugin/email';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { createStorefrontMethods, guestOrder } from './shop';

// docker-compose.yml: Mailpit's SMTP on loopback :1045 and its HTTP API on :8045.
const SMTP_PORT = 1045;
const MAILPIT_API = 'http://127.0.0.1:8045/api/v1';
// How long a storefront email may take through the job queue and SMTP, and how long a POS order gets to send none.
const ARRIVAL_TIMEOUT_MS = 20_000;
const SILENCE_MS = 3_000;

/** The messages Mailpit holds for one recipient. */
async function mailpitCount(address: string): Promise<number> {
  const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  if (!response.ok) throw new Error(`Mailpit search answered ${response.status}`);
  return ((await response.json()) as { messages_count: number }).messages_count;
}

// ADR 0002 follow-up "a real email transport": the exported handler behind Vendure's SMTP transport.
describe('the exported tallyOrderConfirmationHandler over a real SMTP transport (Mailpit)', () => {
  const environment = createPluginTestEnvironment({
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
    plugins: [TallyPosPlugin, EmailPlugin.init({
      handlers: [tallyOrderConfirmationHandler],
      templateLoader: new FileBasedTemplateLoader(join(__dirname, '../node_modules/@vendure/email-plugin/templates')),
      transport: { type: 'smtp', host: '127.0.0.1', port: SMTP_PORT },
      globalTemplateVars: { fromAddress: '"VP2b" <vp2b@vendurepos.invalid>' },
    })],
  });
  const { server, adminClient, shopClient, variantIds } = environment;
  // The confirmation handler's event, so the POS count of 0 cannot pass vacuously.
  const settled: string[] = [];
  beforeAll(async () => {
    await environment.init();
    server.app.get(EventBus).ofType(OrderStateTransitionEvent).subscribe(event => {
      if (event.toState === 'PaymentSettled') settled.push(event.order.code);
    });
  });
  afterAll(() => server.destroy());

  async function jobsIdle() {
    const { jobs } = await adminClient.query<{ jobs: { items: Array<{ state: string }> } }>(parse('query { jobs { items { state } } }'));
    return !jobs.items.some(job => job.state === 'PENDING' || job.state === 'RUNNING');
  }

  it('emails the storefront order exactly once and sends nothing for the POS order placed through the route', async () => {
    // Unique per run: Mailpit keeps its messages between runs.
    const posEmail = `vp2b-pos-${randomUUID()}@example.com`;
    const shopEmail = `vp2b-shop-${randomUUID()}@example.com`;
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, { email: posEmail });
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/commands`, {
      method: 'POST', body: JSON.stringify({ commands: [input] }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1' },
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.results[0]).toMatchObject({ id: input.id, status: 'applied' });

    const { standardShippingId, dummyPaymentCode } = await createStorefrontMethods(adminClient);
    const shop = await guestOrder(shopClient, variantIds.mug[0], shopEmail);
    await shop.setShipping(standardShippingId);
    await shop.arrangePayment();
    const paid = await shop.pay(dummyPaymentCode);
    expect(paid.state).toBe('PaymentSettled');

    const start = performance.now();
    while (await mailpitCount(shopEmail) === 0 && performance.now() - start < ARRIVAL_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(await mailpitCount(shopEmail)).toBe(1);
    // Both orders reached PaymentSettled, the handler's event; the queue is idle, and the POS order gets a margin more.
    expect(settled).toEqual(expect.arrayContaining([body.results[0].serverRefs.displayId, paid.code]));
    while (!await jobsIdle() && performance.now() - start < ARRIVAL_TIMEOUT_MS) await new Promise(resolve => setTimeout(resolve, 200));
    expect(await jobsIdle()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, SILENCE_MS));
    expect(await mailpitCount(posEmail)).toBe(0);
    expect(await mailpitCount(shopEmail)).toBe(1);
  });
});
