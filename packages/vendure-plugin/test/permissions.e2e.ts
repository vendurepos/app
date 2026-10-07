import { randomUUID } from 'node:crypto';
import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
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

  async function tokenWith(permission: 'TallyPosSell' | 'CreateOrder' | 'ReadOrder' | 'ApproveTallyPosVariance' | 'TallyPosRefund') {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `till-${permission}-${randomUUID()}`, description: permission, permissions: [permission], channelIds: [activeChannel.id] } });
    const emailAddress = `${permission}-${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: permission, emailAddress, password: 'till-password', roleIds: [createRole.id] } });
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

  it('ApproveTallyPosVariance and TallyPosRefund are assignable permissions, and the SuperAdmin role holds them', async () => {
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
    expect(roles.items).toHaveLength(1);
    expect(roles.items[0].permissions).toContain('ApproveTallyPosVariance');
    expect(roles.items[0].permissions).toContain('TallyPosRefund');
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
});
