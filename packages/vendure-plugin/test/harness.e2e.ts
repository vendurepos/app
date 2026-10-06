import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { commandFingerprint } from '../src/vendored/fingerprint';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { createPluginTestEnvironment } from './env';

const fixture: CommandEnvelope<OrderCreatePayload> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/order-create-v3.json'), 'utf8'),
);

describe('plugin harness, custom fields and GET /tally/v1/info', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds } = environment;
  beforeAll(() => environment.init());
  afterAll(() => server.destroy());

  it('exposes every POS custom field as read-only on its entity through the Admin API', async () => {
    const { globalSettings } = await adminClient.query<{
      globalSettings: { serverConfig: { entityCustomFields: Array<{
        entityName: string;
        customFields: Array<{ name: string; type: string; readonly: boolean; nullable: boolean }>;
      }> } };
    }>(parse(`query {
      globalSettings { serverConfig { entityCustomFields {
        entityName customFields { ... on CustomField { name type readonly nullable } }
      } } }
    }`));
    const expected = {
      Order: {
        tallyClientOrderId: 'string', tallySaleAt: 'datetime', tallyRegisterId: 'string',
        tallySessionId: 'string', tallyCashierRef: 'string', tallyPayments: 'text', tallySnapshot: 'text',
        tallyRejectedClientOrderId: 'string', tallyRejected: 'boolean',
      },
      OrderLine: { tallyUnitPrice: 'int', tallyClientLineId: 'string', tallyPriceIncludesTax: 'boolean' },
    };
    for (const [entityName, fields] of Object.entries(expected)) {
      const entity = globalSettings.serverConfig.entityCustomFields.find(item => item.entityName === entityName);
      expect(entity).toBeDefined();
      expect(entity!.customFields).toHaveLength(Object.keys(fields).length);
      for (const [name, type] of Object.entries(fields)) {
        expect(entity!.customFields).toContainEqual({ name, type, readonly: true, nullable: true });
      }
    }
  });

  it('seeds EUR, the two tax zones and the requested product variants with stock', async () => {
    const data = await adminClient.query(parse(`query {
      activeChannel { defaultCurrencyCode defaultTaxZone { name } }
      taxRates { items { value zone { name } category { name } } }
      productVariants { items { id price stockOnHand } }
    }`));
    expect(data.activeChannel).toEqual({ defaultCurrencyCode: 'EUR', defaultTaxZone: { name: 'Denmark' } });
    for (const [zone, category, value] of [
      ['Denmark', 'Standard', 25], ['Denmark', 'Reduced', 25], ['Germany', 'Standard', 19], ['Germany', 'Reduced', 7],
    ]) {
      expect(data.taxRates.items).toContainEqual({ value, zone: { name: zone }, category: { name: category } });
    }
    expect(data.productVariants.items).toEqual(expect.arrayContaining([
      { id: variantIds.mug[0], price: 800, stockOnHand: 10 },
      { id: variantIds.beans[0], price: 500, stockOnHand: 10 },
      { id: variantIds.beans[1], price: 900, stockOnHand: 10 },
      { id: variantIds.print[0], price: 4500, stockOnHand: 2 },
    ]));
  });

  it('accepts the vendored v3 fixture shape and fiscal figures, and fingerprints it stably', () => {
    expect(fixture.version).toBe(3);
    expect(payloadShapeErrors(fixture.payload)).toEqual([]);
    expect(fiscalFiguresErrors(fixture.payload)).toEqual([]);
    const fingerprint = commandFingerprint(fixture);
    expect(commandFingerprint(fixture)).toBe(fingerprint);
    const changed = structuredClone(fixture);
    changed.payload.totalMinor += 1;
    expect(commandFingerprint(changed)).not.toBe(fingerprint);
  });

  it('GET /tally/v1/info advertises order.create 1, 2, 3 and 4 to an authenticated caller, and refuses an anonymous one', async () => {
    const url = `${await server.app.getUrl()}/tally/v1/info`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contracts: { 'order.create': [1, 2, 3, 4], register: [1] }, taxRounding: { granularity: 'per_line_items', mode: 'half_up' },
      maxShippingLines: 1, lineTax: { none: true, classes: true },
    });
    expect((await fetch(url)).status).toBe(403);
  });
});
