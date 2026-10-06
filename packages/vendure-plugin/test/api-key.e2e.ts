import { randomUUID } from 'node:crypto';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POS_TILL_PERMISSIONS, POS_TILL_ROLE_CODE } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type Role = { id: string; code: string; description: string; permissions: string[]; channels: Array<{ id: string }> };
const ensureRole = parse(`mutation { tallyEnsurePosTillRole { id code description permissions channels { id } } }`);

describe('POS till API keys', () => {
  const environment = createPluginTestEnvironment({ authOptions: { tokenMethod: ['bearer', 'api-key'] } });
  const { server, adminClient, variantIds } = environment;
  let base: string;
  let channel: { id: string; token: string; defaultTaxZone: { id: string } };
  let roleId: string;
  let key: { apiKey: string; entityId: string };
  let orderId: string;
  beforeAll(async () => {
    await environment.init();
    base = await server.app.getUrl();
    const { activeChannel } = await adminClient.query(parse(`query {
      activeChannel { id token defaultTaxZone { id } }
    }`));
    channel = activeChannel;
  });
  afterAll(async () => { await server.destroy(); });

  const keyHeaders = (apiKey = key.apiKey) => ({ 'vendure-api-key': apiKey, 'vendure-token': channel.token });
  async function keyQuery(query: string, variables: Record<string, unknown> = {}) {
    const response = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: { ...keyHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return body.data;
  }

  it("tallyEnsurePosTillRole creates the POS till role once and keeps a merchant's additions", async () => {
    const first = (await adminClient.query<{ tallyEnsurePosTillRole: Role }>(ensureRole)).tallyEnsurePosTillRole;
    const second = (await adminClient.query<{ tallyEnsurePosTillRole: Role }>(ensureRole)).tallyEnsurePosTillRole;
    roleId = first.id;
    expect(first).toMatchObject({ code: POS_TILL_ROLE_CODE, description: 'VendurePOS till' });
    expect(new Set(first.permissions)).toEqual(new Set([...POS_TILL_PERMISSIONS, 'Authenticated']));
    expect(second).toEqual(first);
    const { roles, channels } = await adminClient.query(parse(`query {
      roles(options: { filter: { code: { eq: "${POS_TILL_ROLE_CODE}" } } }) { totalItems items { id } }
      channels { items { id } }
    }`));
    expect(roles).toEqual({ totalItems: 1, items: [{ id: roleId }] });
    expect(first.channels).toEqual(channels.items);

    await adminClient.query(parse(`mutation Update($input: UpdateRoleInput!) { updateRole(input: $input) { id } }`), {
      input: { id: roleId, permissions: [...POS_TILL_PERMISSIONS, 'ReadOrder'] },
    });
    const { createChannel } = await adminClient.query(parse(`mutation Channel($input: CreateChannelInput!) {
      createChannel(input: $input) { ... on Channel { id } ... on ErrorResult { message } }
    }`), { input: {
      code: 'api-key-second', token: 'api-key-second-token', defaultLanguageCode: 'en', pricesIncludeTax: false,
      defaultCurrencyCode: 'EUR', availableCurrencyCodes: ['EUR'],
      defaultTaxZoneId: channel.defaultTaxZone.id, defaultShippingZoneId: channel.defaultTaxZone.id,
    } });
    expect(createChannel.id).toEqual(expect.any(String));
    const extended = (await adminClient.query<{ tallyEnsurePosTillRole: Role }>(ensureRole)).tallyEnsurePosTillRole;
    expect(extended.id).toBe(roleId);
    expect(new Set(extended.permissions)).toEqual(new Set([...POS_TILL_PERMISSIONS, 'Authenticated', 'ReadOrder']));
    expect(extended.channels.map(item => item.id).sort())
      .toEqual([...first.channels.map(item => item.id), createChannel.id].sort());

    const emailAddress = `till-${randomUUID()}@example.com`;
    await adminClient.query(parse(`mutation Admin($input: CreateAdministratorInput!) {
      createAdministrator(input: $input) { id }
    }`), { input: { firstName: 'Till', lastName: 'Admin', emailAddress, password: 'till-password', roleIds: [roleId] } });
    const login = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") {
        ... on CurrentUser { id } } }` }),
    });
    expect((await login.json()).data.login.id).toEqual(expect.any(String));
    expect(login.headers.get('vendure-auth-token')).toBeTruthy();
    const refused = await fetch(`${base}/admin-api`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${login.headers.get('vendure-auth-token')}`,
      }, body: JSON.stringify({ query: 'mutation { tallyEnsurePosTillRole { id } }' }),
    });
    expect((await refused.json()).errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('an API key with the POS till role does everything a till does', async () => {
    const { createApiKey } = await adminClient.query(parse(`mutation Key($input: CreateApiKeyInput!) {
      createApiKey(input: $input) { apiKey entityId }
    }`), { input: { roleIds: [roleId], translations: [{ languageCode: 'en', name: 'POS till' }] } });
    key = createApiKey;
    expect(key.apiKey).toEqual(expect.any(String));
    const info = await fetch(`${base}/tally/v1/info`, { headers: keyHeaders() });
    expect(info.status).toBe(200);
    expect((await info.json()).device).toEqual({ name: 'POS till' });
    const sessionInfo = await fetch(`${base}/tally/v1/info`, { headers: {
      Authorization: `Bearer ${adminClient.getAuthToken()}`, 'vendure-token': channel.token,
    } });
    expect(sessionInfo.status).toBe(200);
    const body = await sessionInfo.json();
    expect('device' in body).toBe(false);
    const sale = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]);
    const response = await fetch(`${base}/tally/v1/commands`, {
      method: 'POST', headers: { ...keyHeaders(), 'Content-Type': 'application/json', 'X-Tally-Protocol': '1' },
      body: JSON.stringify({ commands: [sale] }),
    });
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: sale.id, status: 'applied' });
    orderId = results[0].serverRefs.orderId;
    expect(orderId).toEqual(expect.any(String));

    const reads = await keyQuery(`query {
      activeChannel { id }
      taxCategories { items { id } }
      taxRates { items { id } }
      globalSettings { trackInventory }
      products(options: { take: 1 }) { items { id variants { id price stockLevels { stockOnHand } } } }
      productVariants(options: { take: 1 }) { items { id } }
      customers(options: { take: 1 }) { items { id } }
    }`);
    expect(reads.activeChannel).toEqual({ id: channel.id });
    for (const list of [reads.taxCategories, reads.taxRates, reads.products, reads.productVariants]) {
      expect(list.items.length).toBeGreaterThan(0);
      expect(list.items[0].id).toEqual(expect.any(String));
    }
    expect(reads.globalSettings.trackInventory).toEqual(expect.any(Boolean));
    expect(reads.products.items[0].variants[0]).toMatchObject({
      id: expect.any(String), price: expect.any(Number), stockLevels: [{ stockOnHand: expect.any(Number) }],
    });
    expect(reads.customers.items).toEqual(expect.any(Array));
    const emailAddress = `customer-${randomUUID()}@example.com`;
    const { createCustomer } = await keyQuery(`mutation Customer($input: CreateCustomerInput!) {
      createCustomer(input: $input) { __typename ... on Customer { id emailAddress } ... on ErrorResult { message } }
    }`, { input: { firstName: 'Till', lastName: 'Customer', emailAddress } });
    expect(createCustomer).toEqual({ __typename: 'Customer', id: expect.any(String), emailAddress });
  });

  it('the audit trail of a sale made with an API key', async () => {
    const { activeAdministrator } = await keyQuery('query { activeAdministrator { id emailAddress } }');
    const audit = await adminClient.query(parse(`query Audit($orderId: ID!, $keyId: ID!) {
      activeAdministrator { id emailAddress user { id } }
      apiKey(id: $keyId) { owner { id } user { id identifier } }
      order(id: $orderId) { history { items { type administrator { id emailAddress } } } }
    }`), { orderId, keyId: key.entityId });
    // API keys use a distinct User with no activeAdministrator; history names the key owner's Administrator.
    expect(activeAdministrator).toBeNull();
    expect(audit.apiKey.owner.id).toBe(audit.activeAdministrator.user.id);
    expect(audit.apiKey.user.id).not.toBe(audit.apiKey.owner.id);
    expect(audit.apiKey.user.identifier).toMatch(/^apikey-user-/);
    const entries = audit.order.history.items as Array<{ type: string; administrator: { id: string; emailAddress: string } | null }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map(entry => entry.type)).toContain('ORDER_STATE_TRANSITION');
    for (const entry of entries) {
      expect(entry.administrator).toEqual({ id: audit.activeAdministrator.id, emailAddress: audit.activeAdministrator.emailAddress });
    }
  });

  it('a rotated key stops working and its replacement works; a deleted key stops working', async () => {
    const { rotateApiKey } = await adminClient.query(parse(`mutation Rotate($id: ID!) {
      rotateApiKey(id: $id) { apiKey }
    }`), { id: key.entityId });
    expect(rotateApiKey.apiKey).not.toBe(key.apiKey);
    const old = await fetch(`${base}/tally/v1/info`, { headers: keyHeaders() });
    expect([401, 403]).toContain(old.status);
    const replacement = await fetch(`${base}/tally/v1/info`, { headers: keyHeaders(rotateApiKey.apiKey) });
    expect(replacement.status).toBe(200);
    const { deleteApiKeys } = await adminClient.query(parse(`mutation Delete($ids: [ID!]!) {
      deleteApiKeys(ids: $ids) { result }
    }`), { ids: [key.entityId] });
    expect(deleteApiKeys).toEqual([{ result: 'DELETED' }]);
    const deleted = await fetch(`${base}/tally/v1/info`, { headers: keyHeaders(rotateApiKey.apiKey) });
    expect([401, 403]).toContain(deleted.status);
  });
});
