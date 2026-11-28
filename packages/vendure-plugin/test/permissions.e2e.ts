import { randomUUID } from 'node:crypto';
import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import { POS_TILL_PERMISSIONS } from '../src/config/pos-till-role';
import type { CommandEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('till route permissions', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let base: string;
  beforeAll(async () => {
    await environment.init();
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 1000 }] });
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
  });
  afterAll(async () => { await server.destroy(); });

  const mug = () => orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
  function exemptMug() {
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: 0 }]);
    Object.assign(command.payload, { taxExempt: true });
    return command;
  }
  let refusedExempt: ReturnType<typeof exemptMug>;
  const headers = (extra: Record<string, string>) => ({
    'Content-Type': 'application/json', 'X-Tally-Protocol': '1', ...extra,
  });
  async function post(body: unknown, extra: Record<string, string>) {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: headers(extra), body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const ledgerFor = (input: CommandEnvelope) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id });
  const ordersFor = (input: CommandEnvelope<{ clientOrderId: string }>) => connection.rawConnection.getRepository(Order).find({
    where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } },
  });

  const infoOf = async (token: Record<string, string>) => (await fetch(`${base}/tally/v1/info`, { headers: headers(token) })).json();

  async function tokenWith(...permissions: ('TallyPosSell' | 'CreateOrder' | 'ReadOrder' | 'ApproveTallyPosVariance' | 'TallyPosRefund' | 'TallyPosTaxExempt')[]) {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `till-${permissions.join('-')}-${randomUUID()}`, description: permissions.join(', '), permissions, channelIds: [activeChannel.id] } });
    const emailAddress = `${permissions[0]}-${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: permissions[0], emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const response = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") {
        ... on CurrentUser { id } ... on ErrorResult { errorCode } } }` }),
    });
    expect((await response.json()).data.login).toMatchObject({ id: expect.any(String) });
    const token = response.headers.get('vendure-auth-token');
    expect(token).toBeTruthy();
    return { Authorization: `Bearer ${token}` };
  }

  it('ApproveTallyPosVariance, TallyPosRefund and TallyPosResetDisplayDevice are assignable permissions, and the SuperAdmin role holds them', async () => {
    const { globalSettings, roles } = await adminClient.query<{
      globalSettings: { serverConfig: { permissions: Array<{ name: string; assignable: boolean }> } };
      roles: { items: Array<{ permissions: string[] }> };
    }>(parse(`query {
      globalSettings { serverConfig { permissions { name assignable } } }
      roles(options: { filter: { code: { eq: "__super_admin_role__" } } }) { items { permissions } }
    }`));
    expect(globalSettings.serverConfig.permissions).toContainEqual({ name: 'ApproveTallyPosVariance', assignable: true });
    expect(globalSettings.serverConfig.permissions).toContainEqual({ name: 'TallyPosRefund', assignable: true });
    expect(globalSettings.serverConfig.permissions).toContainEqual({ name: 'TallyPosSell', assignable: true });
    expect(globalSettings.serverConfig.permissions).toContainEqual({ name: 'TallyPosResetDisplayDevice', assignable: true });
    expect(roles.items).toHaveLength(1);
    expect(roles.items[0].permissions).toContain('ApproveTallyPosVariance');
    expect(roles.items[0].permissions).toContain('TallyPosRefund');
    expect(roles.items[0].permissions).toContain('TallyPosResetDisplayDevice');
  });

  it('a TallyPosSell-only administrator sells and reads /info', async () => {
    const token = await tokenWith('TallyPosSell');
    const sold = mug();
    const response = await post({ commands: [sold] }, token);
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ id: sold.id, status: 'applied' });
    expect((await ordersFor(sold)).map(order => order.state)).toEqual(['Delivered']);
    const info = await fetch(`${base}/tally/v1/info`, { headers: headers(token) });
    expect(info.status).toBe(200);
    expect(await info.json()).toHaveProperty('contracts');
  });

  it('a CreateOrder-only administrator still sells (existing installs need no role change)', async () => {
    const token = await tokenWith('CreateOrder');
    const sold = mug();
    const response = await post({ commands: [sold] }, token);
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ id: sold.id, status: 'applied' });
    expect((await ordersFor(sold)).map(order => order.state)).toEqual(['Delivered']);
  });

  it('a ReadOrder-only administrator is refused', async () => {
    const token = await tokenWith('ReadOrder');
    const refused = mug();
    expect((await post({ commands: [refused] }, token)).status).toBe(403);
    expect(await ledgerFor(refused)).toBeNull();
    expect((await fetch(`${base}/tally/v1/info`, { headers: headers(token) })).status).toBe(403);
  });

  it('an ApproveTallyPosVariance-only administrator is refused: approving a close does not grant selling', async () => {
    const token = await tokenWith('ApproveTallyPosVariance');
    const refused = mug();
    expect((await post({ commands: [refused] }, token)).status).toBe(403);
    expect(await ledgerFor(refused)).toBeNull();
    expect((await fetch(`${base}/tally/v1/info`, { headers: headers(token) })).status).toBe(403);
  });

  it('a TallyPosRefund-only administrator is refused: refunding does not grant selling', async () => {
    const token = await tokenWith('TallyPosRefund');
    const refused = mug();
    expect((await post({ commands: [refused] }, token)).status).toBe(403);
    expect(await ledgerFor(refused)).toBeNull();
    expect((await fetch(`${base}/tally/v1/info`, { headers: headers(token) })).status).toBe(403);
  });

  it('X1: TallyPosTaxExempt is assignable, SuperAdmin holds it, and the till role preset leaves it out', async () => {
    const { globalSettings, roles } = await adminClient.query<{
      globalSettings: { serverConfig: { permissions: Array<{ name: string; assignable: boolean }> } };
      roles: { items: Array<{ permissions: string[] }> };
    }>(parse(`query {
      globalSettings { serverConfig { permissions { name assignable } } }
      roles(options: { filter: { code: { eq: "__super_admin_role__" } } }) { items { permissions } }
    }`));
    expect(globalSettings.serverConfig.permissions).toContainEqual({ name: 'TallyPosTaxExempt', assignable: true });
    expect(roles.items[0].permissions).toContain('TallyPosTaxExempt');
    expect(POS_TILL_PERMISSIONS).not.toContain('TallyPosTaxExempt');
  });

  it('X2: a TallyPosSell-only exempt sale is refused forbidden, unstored, and its /info offers no exemption', async () => {
    const token = await tokenWith('TallyPosSell');
    refusedExempt = exemptMug();
    const response = await post({ commands: [refusedExempt] }, token);
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ id: refusedExempt.id, status: 'rejected',
      error: { code: 'forbidden', message: 'TallyPosTaxExempt is required to exempt a sale from tax' } });
    expect(await ledgerFor(refusedExempt)).toBeNull();
    expect(await ordersFor(refusedExempt)).toEqual([]);
    expect(await infoOf(token)).toMatchObject({ taxExempt: false, taxExemptCoupons: false });
  });

  it('X3: a CreateOrder-only exempt sale is refused the same way', async () => {
    const token = await tokenWith('CreateOrder');
    const command = exemptMug();
    const response = await post({ commands: [command] }, token);
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ id: command.id, status: 'rejected',
      error: { code: 'forbidden', message: 'TallyPosTaxExempt is required to exempt a sale from tax' } });
    expect(await ledgerFor(command)).toBeNull();
    expect(await ordersFor(command)).toEqual([]);
    expect(await infoOf(token)).toMatchObject({ taxExempt: false, taxExemptCoupons: false });
  });

  it('X4: with TallyPosTaxExempt the exempt sale applies untaxed, including the id X2 refused', async () => {
    const token = await tokenWith('TallyPosSell', 'TallyPosTaxExempt');
    expect(await infoOf(token)).toMatchObject({ taxExempt: true, taxExemptCoupons: false });
    const response = await post({ commands: [refusedExempt] }, token);
    expect(response.body.results[0]).toMatchObject({ id: refusedExempt.id, status: 'applied' });
    const orders = await ordersFor(refusedExempt);
    expect(orders).toHaveLength(1);
    const [order] = orders;
    expect(order.totalWithTax).toBe(order.total);
    expect(JSON.parse(order.customFields.tallySnapshot!)).toMatchObject({ taxExempt: true });
  });

  it('X5: without TallyPosTaxExempt a taxed sale still applies, and the exempt sale X4 applied replays as recorded', async () => {
    const token = await tokenWith('TallyPosSell');
    const command = mug();
    expect((await post({ commands: [command] }, token)).body.results[0]).toMatchObject({ id: command.id, status: 'applied' });
    expect((await post({ commands: [refusedExempt] }, token)).body.results[0]).toMatchObject({ id: refusedExempt.id, status: 'duplicate' });
  });

  it('X6: a TallyPosTaxExempt-only administrator is refused: exempting does not grant selling', async () => {
    const token = await tokenWith('TallyPosTaxExempt');
    const refused = exemptMug();
    expect((await post({ commands: [refused] }, token)).status).toBe(403);
    expect(await ledgerFor(refused)).toBeNull();
    expect((await fetch(`${base}/tally/v1/info`, { headers: headers(token) })).status).toBe(403);
  });
});
