import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrderLevelTaxCalculationStrategy } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderCreateResult } from '../src/service/order-create.service';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';

type Envelope = CommandEnvelope<OrderCreatePayload>;
class RoundedOrderLevelTax extends OrderLevelTaxCalculationStrategy {}
const read = (name: string) => readFileSync(join(__dirname, `fixtures/order-create-v4-${name}.json`), 'utf8');
const base = (JSON.parse(read('exclusive')) as Envelope).payload.taxMinor;
let variantIds: ReturnType<typeof createPluginTestEnvironment>['variantIds'];
let sequence = 0;

function fixture(name: string): Envelope {
  const command: Envelope = JSON.parse(read(name)
    .replaceAll('"VARIANT_A"', JSON.stringify(variantIds.mug[0]))
    .replaceAll('"VARIANT_B"', JSON.stringify(variantIds.beans[0])));
  command.id = `01a0e775-0200-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
  command.payload.clientOrderId = `01a0e775-0200-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
  return command;
}

function shifted(version: number): Envelope {
  const command = fixture('exclusive');
  command.version = version as Envelope['version'];
  command.payload.taxMinor += 5;
  command.payload.display!.taxMinor += 5;
  command.payload.taxByRate![0].taxMinor += 5;
  command.payload.taxByRate![0].grossMinor += 5;
  return command;
}

const figures = (result: OrderCreateResult) => result.warnings?.find(w => w.code === 'figures_mismatch');

describe('figures_mismatch with per_line_items', () => {
  const environment = createPluginTestEnvironment();
  const { server, run } = environment;
  beforeAll(async () => {
    await environment.init();
    variantIds = environment.variantIds;
  });
  afterAll(() => server.destroy());

  it('the published till\'s v4 figures match exactly: no figures_mismatch', async () => {
    for (const name of ['exclusive', 'inclusive', 'mixed-inclusive', 'mixed-exclusive']) {
      const result = await run(fixture(name));
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
      expect(figures(result), JSON.stringify(result)).toBeUndefined();
    }
  });

  it('a v4 tax figure off by 5 gives one figures_mismatch naming taxMinor with both values', async () => {
    const result = await run(shifted(4));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    expect(figures(result), JSON.stringify(result)).toEqual({
      code: 'figures_mismatch', fields: [{ field: 'taxMinor', tillMinor: base + 5, serverMinor: base }],
    });
    expect(result.warnings!.filter(w => w.code === 'figures_mismatch')).toHaveLength(1);
    expect(result.totalWarnings).toContainEqual(expect.objectContaining({ code: 'tax_rate_mismatch' }));
  });

  it('v3 never gets figures_mismatch', async () => {
    const result = await run(shifted(3));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    expect(figures(result)).toBeUndefined();
    expect(result.totalWarnings).toContainEqual(expect.objectContaining({ code: 'tax_rate_mismatch' }));
  });
});

describe('figures_mismatch with per_rate_group_items', () => {
  const environment = createPluginTestEnvironment({
    taxOptions: { orderTaxCalculationStrategy: new OrderLevelTaxCalculationStrategy() },
  });
  const { server, run } = environment;
  beforeAll(async () => {
    await environment.init();
    variantIds = environment.variantIds;
  });
  afterAll(() => server.destroy());

  it('per_rate_group_items compares an exclusive order\'s tax', async () => {
    const result = await run(shifted(4));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const rate = result.totalWarnings?.find(w => w.code === 'tax_rate_mismatch');
    expect(rate).toBeDefined();
    expect(figures(result), JSON.stringify(result)).toEqual({
      code: 'figures_mismatch', fields: [{ field: 'taxMinor', tillMinor: base + 5, serverMinor: rate!.serverMinor }],
    });
    // The store rounds per rate group, so its tax for this per-line basket differs from A's, and the warning carries the store's own value.
    expect(rate!.serverMinor).not.toBe(base);
  });

  it('per_rate_group_items with an inclusive line compares no subtotal or tax', async () => {
    const command = fixture('inclusive');
    command.payload.taxMinor += 5;
    command.payload.display!.taxMinor += 5;
    command.payload.taxByRate![0].taxMinor += 5;
    command.payload.taxByRate![0].grossMinor += 5;
    const result = await run(command);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    expect(figures(result)?.fields.some(field => field.field === 'subtotalMinor' || field.field === 'taxMinor')).not.toBe(true);
  });
});

describe('figures_mismatch with a custom strategy', () => {
  const environment = createPluginTestEnvironment({
    taxOptions: { orderTaxCalculationStrategy: new RoundedOrderLevelTax() },
  });
  const { server, run } = environment;
  beforeAll(async () => {
    await environment.init();
    variantIds = environment.variantIds;
  });
  afterAll(() => server.destroy());

  it('a custom strategy compares no subtotal or tax', async () => {
    const result = await run(shifted(4));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    expect(figures(result), JSON.stringify(result)).toBeUndefined();
  });
});
