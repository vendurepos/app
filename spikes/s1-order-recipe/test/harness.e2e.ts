import { readFileSync } from 'node:fs';
import { TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { commandFingerprint } from '../src/vendored/fingerprint';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { createS1TestEnvironment } from './env';

const fixture: CommandEnvelope<OrderCreatePayload> = JSON.parse(
  readFileSync(new URL('./fixtures/order-create-v3.json', import.meta.url), 'utf8'),
);

describe('S1 harness', () => {
  const environment = createS1TestEnvironment();
  const { server, adminClient, variantIds } = environment;
  beforeAll(() => environment.init());
  afterAll(() => server.destroy());

  it('boots and exposes every readonly POS custom field on its entity through the Admin API', async () => {
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

  it('creates the tally_command table in Postgres', async () => {
    const connection = server.app.get(TransactionalConnection);
    const rows = await connection.rawConnection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tally_command'",
    );
    expect(rows).toEqual([{ table_name: 'tally_command' }]);
  });

  it('seeds EUR, the two tax zones and the requested product variants with stock', async () => {
    const data = await adminClient.query(parse(`query {
      activeChannel { defaultCurrencyCode defaultTaxZone { name } }
      zones { items { name members { code } } }
      taxRates { items { value zone { name } category { name } } }
      productVariants { items { id price currencyCode stockOnHand taxCategory { name } product { name } } }
    }`));
    expect(data.activeChannel).toEqual({ defaultCurrencyCode: 'EUR', defaultTaxZone: { name: 'Denmark' } });
    expect(data.zones.items).toEqual(expect.arrayContaining([
      { name: 'Denmark', members: [{ code: 'DK' }] }, { name: 'Germany', members: [{ code: 'DE' }] },
    ]));
    expect(data.taxRates.items).toHaveLength(4);
    for (const [zone, category, value] of [
      ['Denmark', 'Standard', 25], ['Denmark', 'Reduced', 25],
      ['Germany', 'Standard', 19], ['Germany', 'Reduced', 7],
    ]) {
      expect(data.taxRates.items).toContainEqual({ value, zone: { name: zone }, category: { name: category } });
    }
    expect(data.productVariants.items).toHaveLength(4);
    for (const [id, name, price, category, stock] of [
      [variantIds.mug[0], 'Mug', 800, 'Standard', 10],
      [variantIds.beans[0], 'Beans', 500, 'Reduced', 10],
      [variantIds.beans[1], 'Beans', 900, 'Reduced', 10],
      [variantIds.print[0], 'Print', 4500, 'Standard', 2],
    ]) {
      expect(data.productVariants.items).toContainEqual({
        id, product: { name }, price, currencyCode: 'EUR', taxCategory: { name: category }, stockOnHand: stock,
      });
    }
  });

  it('accepts the vendored v3 fixture shape and fiscal figures', () => {
    expect(fixture.version).toBe(3);
    expect(payloadShapeErrors(fixture.payload)).toEqual([]);
    expect(fiscalFiguresErrors(fixture.payload)).toEqual([]);
  });

  it('fingerprints the fixture envelope consistently and detects a payload change', () => {
    const fingerprint = commandFingerprint(fixture);
    expect(commandFingerprint(fixture)).toBe(fingerprint);
    const changed = structuredClone(fixture);
    changed.payload.totalMinor += 1;
    expect(commandFingerprint(changed)).not.toBe(fingerprint);
  });
});
