import { randomUUID } from 'node:crypto';
import { Order, Permission, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import type { CommandEnvelope } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

const listQuery = `query { tallyNeedsAdminCommands { id clientOrderId channelId orderId orderCode createdAt } }`;
const resolveMutation = `mutation Resolve($commandId: String!, $resolution: TallyNeedsAdminResolution!, $note: String!) {
  tallyResolveNeedsAdmin(commandId: $commandId, resolution: $resolution, note: $note) { id status }
}`;

describe('Tally Admin API', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode } = environment;
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
  afterAll(async () => {
    await server.destroy();
  });

  const mug = () => orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
  const headers = (extra: Record<string, string> = {}) => ({
    'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1', ...extra,
  });
  async function post(body: unknown, extra?: Record<string, string>) {
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: headers(extra), body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  }
  const ledgerFor = (input: CommandEnvelope) => connection.rawConnection.getRepository(TallyCommand).findOneBy({ id: input.id });
  const ordersFor = (input: CommandEnvelope<{ clientOrderId: string }>) => connection.rawConnection.getRepository(Order).find({
    where: { customFields: { tallyClientOrderId: input.payload.clientOrderId } }, relations: ['payments'],
  });

  async function tokenWith(permissions: Permission[]) {
    const { activeChannel } = await adminClient.query<{ activeChannel: { id: string } }>(parse('query { activeChannel { id } }'));
    const { createRole } = await adminClient.query<{ createRole: { id: string } }>(parse(`mutation Role($input: CreateRoleInput!) {
      createRole(input: $input) { id }
    }`), { input: { code: `till-${randomUUID()}`, description: 'Till', permissions, channelIds: [activeChannel.id] } });
    const emailAddress = `${randomUUID()}@till.example`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`),
      { input: { firstName: 'Till', lastName: 'Admin', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
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

  it('a needs_admin sale is listed with its order and resolved as applied: resends become duplicate and the list empties', async () => {
    const input = mug();
    const firstResult = (await post({ commands: [input] })).body.results[0];
    expect(firstResult.status).toBe('applied');
    expect((await ledgerFor(input))!.topUps ?? []).toEqual([]);
    await connection.rawConnection.getRepository(TallyCommand).update({ id: input.id }, { status: 'needs_admin' });
    const { tallyNeedsAdminCommands } = await adminClient.query(parse(listQuery));
    expect(tallyNeedsAdminCommands).toEqual([{
      id: input.id, clientOrderId: input.payload.clientOrderId, channelId: expect.any(String),
      orderId: firstResult.serverRefs.orderId, orderCode: firstResult.serverRefs.displayId, createdAt: expect.any(String),
    }]);
    expect((await post({ commands: [input] })).status).toBe(409);
    const { tallyResolveNeedsAdmin } = await adminClient.query(parse(resolveMutation), {
      commandId: input.id, resolution: 'applied', note: 'checked the till',
    });
    expect(tallyResolveNeedsAdmin).toEqual({ id: input.id, status: 'applied' });
    expect((await ledgerFor(input))!.status).toBe('applied');
    expect((await post({ commands: [input] })).body.results[0]).toEqual({ ...firstResult, status: 'duplicate' });
    expect((await adminClient.query(parse(listQuery))).tallyNeedsAdminCommands).toEqual([]);
  });

  it("resolved as rejected, the order is cancelled and the resend answers the admin's note", async () => {
    const input = mug();
    const firstResult = (await post({ commands: [input] })).body.results[0];
    expect(firstResult.status).toBe('applied');
    expect((await ledgerFor(input))!.topUps ?? []).toEqual([]);
    await connection.rawConnection.getRepository(TallyCommand).update({ id: input.id }, { status: 'needs_admin' });
    const { tallyResolveNeedsAdmin } = await adminClient.query(parse(resolveMutation), {
      commandId: input.id, resolution: 'rejected', note: '  wrong till  ',
    });
    expect(tallyResolveNeedsAdmin).toEqual({ id: input.id, status: 'rejected' });
    expect(await ordersFor(input)).toEqual([]);
    expect(await connection.rawConnection.getRepository(Order).findOneByOrFail({ id: decode(firstResult.serverRefs.orderId) }))
      .toMatchObject({ state: 'Cancelled', customFields: { tallyRejected: true } });
    const resend = (await post({ commands: [input] })).body.results[0];
    expect(resend.status).toBe('rejected');
    expect(resend.error.message).toBe('TALLY_ADMIN_REJECTED: wrong till');
  });

  it('a blank note is refused and changes nothing', async () => {
    const input = mug();
    expect((await post({ commands: [input] })).body.results[0].status).toBe('applied');
    expect((await ledgerFor(input))!.topUps ?? []).toEqual([]);
    await connection.rawConnection.getRepository(TallyCommand).update({ id: input.id }, { status: 'needs_admin' });
    const before = await ledgerFor(input);
    await expect(adminClient.query(parse(resolveMutation), {
      commandId: input.id, resolution: 'applied', note: '   ',
    })).rejects.toThrow('A note is required');
    expect(await ledgerFor(input)).toEqual(before);
    expect((await ledgerFor(input))!.status).toBe('needs_admin');
  });

  it('a row that does not need an admin is refused', async () => {
    const input = mug();
    expect((await post({ commands: [input] })).body.results[0].status).toBe('applied');
    await expect(adminClient.query(parse(resolveMutation), {
      commandId: input.id, resolution: 'applied', note: 'checked the till',
    })).rejects.toThrow('does not need an admin');
  });

  it('only a SuperAdmin may list or resolve', async () => {
    const input = mug();
    expect((await post({ commands: [input] })).body.results[0].status).toBe('applied');
    expect((await ledgerFor(input))!.topUps ?? []).toEqual([]);
    await connection.rawConnection.getRepository(TallyCommand).update({ id: input.id }, { status: 'needs_admin' });
    const token = await tokenWith([Permission.CreateOrder, Permission.UpdateOrder, Permission.ReadOrder]);
    for (const query of [listQuery, resolveMutation]) {
      const response = await fetch(`${base}/admin-api`, {
        method: 'POST', headers: headers(token), body: JSON.stringify({ query, variables: {
          commandId: input.id, resolution: 'rejected', note: 'wrong till',
        } }),
      });
      expect((await response.json()).errors[0].extensions.code).toBe('FORBIDDEN');
    }
    expect((await ledgerFor(input))!.status).toBe('needs_admin');
  });
});
