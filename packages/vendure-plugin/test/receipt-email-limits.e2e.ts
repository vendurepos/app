import { randomUUID } from 'node:crypto';
import { Global } from '@nestjs/common';
import { PluginCommonModule, TransactionalConnection, VendurePlugin } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyPosPlugin } from '../src';
import { TALLY_DISPLAY_CLOCK } from '../src/service/display-signalling.service';
import { bootstrapSecondInstance, createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

const SECOND = 1000, DAY = 24 * 60 * 60 * SECOND;

// The clock behind every window, moved by `offset`. Global, so both instances' services take it.
let offset = 0;
@Global()
@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [{ provide: TALLY_DISPLAY_CLOCK, useValue: () => Date.now() + offset }],
  exports: [TALLY_DISPLAY_CLOCK],
})
class ReceiptClockPlugin {}

type Answer = { status: number; body: Record<string, any> };

describe('#345: the receipt-email per-order and daily caps are kept in the database', () => {
  // No EmailPlugin: the route answers 202 once the event is published.
  const environment = createPluginTestEnvironment({}, [
    TallyPosPlugin.init({ receiptEmail: { perOrder: 2, perUserPerMinute: 1000, perUserPerDay: 4, perChannelPerDay: 6 } }), ReceiptClockPlugin]);
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let second: Awaited<ReturnType<typeof bootstrapSecondInstance>>;
  let a: string, admin: string, channel: string;
  let till: { headers: Record<string, string>; id: string };

  // receipt-email.e2e.ts's helpers: one route call, a till sale, a till user's login (here with its user id too).
  const call = async (base: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`${base}/tally/v1/${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1', ...headers } });
    return { status: response.status, body: await response.json() };
  };
  const sale = async (email?: string): Promise<string> => (await call(a, 'commands', { commands: [orderCommand(
    [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }], undefined, email ? { email } : undefined)] })).body.results[0].serverRefs.displayId;
  const tokenWith = async (permissions: string[]) => {
    const { activeChannel } = await adminClient.query(parse('query { activeChannel { id } }')), emailAddress = `${randomUUID()}@till.example`;
    const { createRole } = await adminClient.query(parse('mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }'),
      { input: { code: `r345-${randomUUID()}`, description: '#345', permissions, channelIds: [activeChannel.id] } });
    await adminClient.query(parse('mutation($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }'),
      { input: { firstName: 'Till', lastName: '#345', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const login = await fetch(`${await server.app.getUrl()}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") { ... on CurrentUser { id } } }` }) });
    const headers = { Authorization: `Bearer ${login.headers.get('vendure-auth-token')}` };
    return { headers, id: environment.decode((await login.json()).data.login.id) };
  };
  const email = () => `r345-${randomUUID()}@example.com`;
  const receipt = (code: string, at = a, headers: Record<string, string> = {}, body?: unknown) => call(at, `orders/${code}/receipt-email`, body, headers);
  /** Sends `n` receipts, each of a new order, one at a time; their statuses. */
  const statuses = async (n: number, headers: Record<string, string> = {}) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await receipt(await sale(email()), a, headers)).status);
    return out;
  };
  const row = async (key: string): Promise<{ sends: number; expiresAt: Date }> =>
    (await connection.rawConnection.query('SELECT "sends", "expiresAt" FROM "tally_receipt_email_window" WHERE "key" = $1', [key]))[0];
  const orderKey = async (code: string) =>
    `order:${(await connection.rawConnection.query('SELECT "id" FROM "order" WHERE "code" = $1', [code]))[0].id}`;
  const refusal = (code: string, message: string, retryAt: Date) =>
    ({ status: 429, body: { code, message: `${message}; another can be sent after ${retryAt.toISOString()}`, retryAt: retryAt.toISOString() } });

  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    a = await server.app.getUrl();
    // The second instance defaults to REPEATABLE READ, as a merchant database could, so test 2 races across both defaults.
    second = await bootstrapSecondInstance(connection.rawConnection.options.database as string,
      { dbConnectionOptions: { extra: { options: '-c default_transaction_isolation=repeatable\\ read' } } }, [TallyPosPlugin, ReceiptClockPlugin]);
    expect((await second.app.get(TransactionalConnection).rawConnection.query('SHOW default_transaction_isolation'))[0])
      .toEqual({ default_transaction_isolation: 'repeatable read' });
    const { me, activeChannel } = await adminClient.query(parse('query { me { id } activeChannel { id } }'));
    [admin, channel] = [environment.decode(me.id), environment.decode(activeChannel.id)];
    till = await tokenWith(['TallyPosSell', 'ReadOrder']);
  });
  afterAll(async () => {
    TallyPosPlugin.init({});
    await second?.app.close();
    await server.destroy();
  });

  it('the per-order count is in the database: a second instance sees the first\'s sends', async () => {
    offset += 31 * DAY;
    const code = await sale(email());
    expect([(await receipt(code)).status, (await receipt(code, second.url)).status]).toEqual([202, 202]);
    const answers = [await receipt(code), await receipt(code, second.url)], key = await orderKey(code), { expiresAt } = await row(key);
    expect(answers).toEqual(Array(2).fill(refusal('order_send_limit', 'This order already had 2 receipt emails', expiresAt)));
    // The restart proof: a fresh instance knows only what the table holds.
    expect((await connection.rawConnection.query('SELECT "sends" FROM "tally_receipt_email_window" WHERE "key" = $1', [key]))[0].sends).toBe(2);
  });

  it('two instances racing one order: exactly perOrder sends are accepted', async () => {
    offset += 31 * DAY;
    const code = await sale(email());
    const answers = await Promise.all([a, second.url, a, second.url, a, second.url].map(at => receipt(code, at)));
    expect(answers.map(answer => `${answer.status} ${answer.body.code ?? 'queued'}`).sort())
      .toEqual(['202 queued', '202 queued', ...Array(4).fill('429 order_send_limit')]);
  });

  it('a user gets perUserPerDay sends a day, and the window reopens after 24 hours', async () => {
    offset += 31 * DAY;
    expect(await statuses(4, till.headers)).toEqual([202, 202, 202, 202]);
    const refused = await receipt(await sale(email()), a, till.headers), { expiresAt } = await row(`user:${till.id}`);
    expect(refused).toEqual(refusal('user_daily_limit', 'This user already sent 4 receipt emails today', expiresAt));
    offset += DAY + SECOND;
    expect(await statuses(1, till.headers)).toEqual([202]);
  });

  it('the channel gets perChannelPerDay sends a day across users', async () => {
    offset += 31 * DAY;
    expect(await statuses(2)).toEqual([202, 202]);
    offset += 60 * SECOND;
    expect(await statuses(4, till.headers)).toEqual([202, 202, 202, 202]);
    const [channelRow, userRow] = [await row(`channel:${channel}`), await row(`user:${till.id}`)];
    expect([channelRow.sends, userRow.sends]).toEqual([6, 4]);
    expect(userRow.expiresAt.getTime() - channelRow.expiresAt.getTime()).toBeGreaterThanOrEqual(60 * SECOND);
    expect(await receipt(await sale(email()))).toEqual(refusal('channel_daily_limit', 'This store already sent 6 receipt emails today', channelRow.expiresAt));
    // Both of the till user's keys are full: the code is the user's, the retryAt the later window's end.
    expect(await receipt(await sale(email()), a, till.headers)).toEqual(refusal('user_daily_limit', 'This user already sent 4 receipt emails today', userRow.expiresAt));
  });

  it('a refused request counts nothing', async () => {
    offset += 31 * DAY;
    const code = await sale(email());
    expect([(await receipt(code)).status, (await receipt(code)).status]).toEqual([202, 202]);
    const counts = async () => [(await row(`user:${admin}`)).sends, (await row(`channel:${channel}`)).sends];
    expect(await counts()).toEqual([2, 2]);
    expect(await receipt(code)).toMatchObject({ status: 429, body: { code: 'order_send_limit' } });
    expect(await receipt(code, a, {}, { extra: 1 })).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
    expect(await receipt(await sale(), a, {}, {})).toMatchObject({ status: 422, body: { code: 'no_recipient' } });
    expect(await counts()).toEqual([2, 2]);
  });

  it('expired windows are pruned', async () => {
    offset += 31 * DAY;
    const code = await sale(email());
    expect((await receipt(code)).status).toBe(202);
    const now = new Date(Date.now() + offset);
    const rows: Array<{ key: string; expiresAt: Date }> = await connection.rawConnection.query('SELECT "key", "expiresAt" FROM "tally_receipt_email_window"');
    expect(rows.filter(found => found.expiresAt <= now)).toEqual([]);
    expect(rows.map(found => found.key).sort()).toEqual([`channel:${channel}`, await orderKey(code), `user:${admin}`].sort());
  });
});
