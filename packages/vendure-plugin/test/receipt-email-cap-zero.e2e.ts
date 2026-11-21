import { randomUUID } from 'node:crypto';
import { TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyPosPlugin } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('#347: a receipt-email cap of 0 refuses every send', () => {
  // No EmailPlugin: a send that passed would answer 202 once the event is published.
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin.init({ receiptEmail: { perOrder: 0 } })]);
  const { server, adminClient, variantIds } = environment;
  beforeAll(() => environment.init());
  afterAll(() => (TallyPosPlugin.init({}), server.destroy()));

  // receipt-email-limits.e2e.ts's helpers: one route call, a till sale, a fresh address.
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1' } });
    return { status: response.status, body: await response.json() };
  };
  const sale = async (email?: string): Promise<string> => (await call('commands', { commands: [orderCommand(
    [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, email ? { email } : undefined)] })).body.results[0].serverRefs.displayId;
  const receipt = (code: string) => call(`orders/${code}/receipt-email`);
  const email = () => `r347-${randomUUID()}@example.com`;

  it('perOrder: 0 answers order_send_limit with no retryAt on every send, and writes no row', async () => {
    const code = await sale(email());
    const refused = { status: 429, body: { code: 'order_send_limit', message: 'The `perOrder` cap is 0, so no receipt email can be sent' } };
    expect(await receipt(code)).toEqual(refused);
    expect(await receipt(code)).toEqual(refused);
    const [{ count }] = await server.app.get(TransactionalConnection).rawConnection.query('SELECT count(*) FROM "tally_receipt_email_window"');
    expect(Number(count)).toBe(0);
  });
});
