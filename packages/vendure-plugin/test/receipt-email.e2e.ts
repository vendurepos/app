import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
// The package's own exports (dist/, so `npm run build` first), as a store installs them.
import { tallyOrderConfirmationHandler, tallyReceiptEmailHandler } from '@vendurepos/plugin/email';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WALK_IN_EMAIL } from '../src/service/constants';
import { createPluginTestEnvironment, testStack } from './env';
import { orderCommand } from './payloads';
import { guestOrder } from './shop';

// The main entry from dist/ too, so the route's event is the listener's class; computed, as the typecheck runs before the build.
const { TallyPosPlugin } = require('@vendurepos/plugin' as string) as typeof import('../src');

/** Mailpit's messages to `address`, once the first has arrived or 20 s have passed (email-smtp.e2e.ts's wait). */
async function mailpit(address: string, start = performance.now()): Promise<{ messages_count: number; messages: Array<{ Subject: string }> }> {
  const found = await (await fetch(`http://127.0.0.1:${testStack.mailpitPort}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json();
  if (found.messages_count > 0 || performance.now() - start > 20_000) return found;
  await new Promise(resolve => setTimeout(resolve, 200));
  return mailpit(address, start);
}

describe('12.1a: POST /tally/v1/orders/:code/receipt-email', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin.init({ receiptEmail: true }), EmailPlugin.init({
    handlers: [tallyOrderConfirmationHandler, tallyReceiptEmailHandler],
    templateLoader: new FileBasedTemplateLoader(join(__dirname, '../node_modules/@vendure/email-plugin/templates')),
    transport: { type: 'smtp', host: '127.0.0.1', port: testStack.smtpPort },
    globalTemplateVars: { fromAddress: '"12.1a" <receipt@vendurepos.invalid>' },
  })]);
  const { server, adminClient, shopClient, variantIds } = environment;
  beforeAll(() => environment.init());
  afterAll(() => (TallyPosPlugin.init({}), server.destroy()));
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1' } });
    return { status: response.status, body: await response.json() };
  };
  const sale = async (email?: string): Promise<string> => (await call('commands', { commands: [orderCommand(
    [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, email ? { email } : undefined)] })).body.results[0].serverRefs.displayId;
  const receipt = (code: string, body?: unknown) => call(`orders/${code}/receipt-email`, body);
  const address = () => `r121a-${randomUUID()}@example.com`;
  it('sends the till customer one receipt, and the automatic confirmation sends nothing', async () => {
    const a = address(), code = await sale(a);
    expect(await receipt(code)).toEqual({ status: 202, body: { queued: true, emailAddress: a } });
    expect(await mailpit(a)).toMatchObject({ messages_count: 1, messages: [{ Subject: `Receipt for order #${code}` }] });
  });
  it('a walk-in sale needs a typed address, and the walk-in customer keeps its email', async () => {
    const b = address(), code = await sale();
    expect(await receipt(code, {})).toMatchObject({ status: 422, body: { code: 'no_recipient' } });
    expect(await receipt(code, { emailAddress: ` ${b} ` })).toEqual({ status: 202, body: { queued: true, emailAddress: b } });
    expect((await mailpit(b)).messages_count).toBe(1);
    const { orders } = await adminClient.query(parse('query($code: String!) { orders(options: { filter: { code: { eq: $code } } }) { items { customer { emailAddress } } } }'), { code });
    expect(orders.items[0].customer.emailAddress).toBe(WALK_IN_EMAIL);
  });
  it('refuses an unknown order, a bad address, an extra key and a storefront order', async () => {
    const a = address(), code = await sale(a), shop = await guestOrder(shopClient, variantIds.mug[0], address());
    expect(await receipt('NO-SUCH-ORDER')).toMatchObject({ status: 404, body: { code: 'order_not_found' } });
    expect(await receipt(code, { emailAddress: 'not-an-email' })).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
    expect(await receipt(code, { emailAddress: a, extra: 1 })).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
    expect(await receipt(shop.added.code!)).toMatchObject({ status: 409, body: { code: 'not_till_order' } });
  });
  it('GET /tally/v1/info advertises receiptEmail', async () => {
    expect(await call('info', undefined, 'GET')).toMatchObject({ status: 200, body: { receiptEmail: { v: 1 } } });
  });
});
