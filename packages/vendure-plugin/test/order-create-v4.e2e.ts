import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Order, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { createPluginTestEnvironment } from './env';

// TallyUI #286/#291: order.create v4 is v3 with every discountMinor tax-exclusive. The fixtures are the published
// till's own envelopes (@tallyui/pos 3.0.0-next.0 toOrderCreateEnvelope, taxRounding per_line_items half_up, the
// plugin's /info), TallyUI #285's worked basket at this environment's 25 % rate: one rate group, so a bridge can only
// come from the discount (vendurepos #38). order-create-v4-expected.json holds the till's own gross line discounts.
type Envelope = CommandEnvelope<OrderCreatePayload>;
type Expected = Record<string, { totalMinor: number; lines: Record<string, {
  taxInclusive: boolean; grossDiscountMinor: number; sentDiscountMinor: number;
}> }>;
const read = (name: string) => readFileSync(join(__dirname, `fixtures/order-create-v4-${name}.json`), 'utf8');
const expected: Expected = JSON.parse(read('expected'));

describe('order.create version 4: net discounts', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  // The fixtures name their variants by placeholder; this environment's ids replace them.
  const fixture = (name: string): Envelope => JSON.parse(read(name)
    .replaceAll('"VARIANT_A"', JSON.stringify(variantIds.mug[0]))
    .replaceAll('"VARIANT_B"', JSON.stringify(variantIds.beans[0])));

  async function applied(name: string, version: number) {
    const command = fixture(name);
    expect(command.version).toBe(version);
    expect(payloadShapeErrors(command.payload)).toEqual([]);
    expect(fiscalFiguresErrors(command.payload)).toEqual([]);
    const result = await run(command);
    expect(result, JSON.stringify(result)).toMatchObject({ id: command.id, status: 'applied' });
    // No total_mismatch bridge and no tax_rate_mismatch: the server's totals are the till's to the minor unit.
    expect(result.totalWarnings).toBeUndefined();
    expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines', 'surcharges'],
    });
    expect(encode(order.id)).toBe(result.serverRefs!.orderId);
    expect(order.totalWithTax).toBe(command.payload.totalMinor);
    expect(order.totalWithTax).toBe(expected[name].totalMinor);
    // One TALLY-DISCOUNT surcharge per discounted line, saved in payload order.
    const surcharges = [...order.surcharges].sort((a, b) => Number(a.id) - Number(b.id));
    expect(surcharges.map(surcharge => surcharge.sku)).toEqual(command.payload.lines.map(() => 'TALLY-DISCOUNT'));
    return { command, order, surcharges };
  }

  for (const name of ['exclusive', 'inclusive', 'mixed-inclusive', 'mixed-exclusive']) {
    it(`${name}: applied with no bridge, each net discount grossed up to the till's gross line discount`, async () => {
      const { command, order, surcharges } = await applied(name, 4);
      command.payload.lines.forEach((line, index) => {
        const till = expected[name].lines[line.clientLineId];
        expect(line.discountMinor).toBe(till.sentDiscountMinor);
        expect(surcharges[index]).toMatchObject({ listPrice: -till.sentDiscountMinor, listPriceIncludesTax: false });
        expect(surcharges[index].priceWithTax, `${name} ${line.title}`).toBe(-till.grossDiscountMinor);
        expect(surcharges[index].taxLines.map(tax => tax.taxRate)).toEqual([25]);
      });
      // v4 carries v3's fields: the receipt snapshot is stored.
      expect(JSON.parse(order.customFields.tallySnapshot!)).toEqual({
        display: command.payload.display, taxByRate: command.payload.taxByRate,
      });
    });
  }

  it('the inclusive fixtures send a net discount below the gross one, so the v4 branch is exercised', () => {
    for (const name of ['inclusive', 'mixed-inclusive', 'mixed-exclusive']) {
      const inclusive = Object.values(expected[name].lines).filter(line => line.taxInclusive);
      expect(inclusive.length).toBeGreaterThan(0);
      for (const line of inclusive) expect(line.sentDiscountMinor).toBeLessThan(line.grossDiscountMinor);
    }
  });

  it('v3 unchanged: the inclusive basket sent as v3 carries gross discounts, applied in the line\'s own mode', async () => {
    const { command, surcharges } = await applied('inclusive-sent-as-v3', 3);
    expect(command.payload.totalMinor).toBe(expected.inclusive.totalMinor);
    command.payload.lines.forEach((line, index) => {
      const till = expected['inclusive-sent-as-v3'].lines[line.clientLineId];
      expect(line.discountMinor).toBe(till.grossDiscountMinor);
      expect(surcharges[index]).toMatchObject({ listPrice: -till.grossDiscountMinor, listPriceIncludesTax: true });
      expect(surcharges[index].priceWithTax).toBe(-till.grossDiscountMinor);
    });
  });

  it('a v4 command with v3\'s fields passes the strict shape and still refuses an unknown field', async () => {
    const command = fixture('exclusive');
    const misspelt = structuredClone(command) as unknown as {
      id: string; payload: { clientOrderId: string; lines: Array<Record<string, unknown>> };
    };
    // New ids, so neither the replay read nor the collision lookup answers before the strict check.
    misspelt.id = '01a0e775-0100-7000-8000-00000000f004';
    misspelt.payload.clientOrderId = '01a0e775-0100-7000-8000-00000000f104';
    misspelt.payload.lines[0].discountMinr = 1;
    const result = await run(misspelt as unknown as Envelope);
    expect(result.status).toBe('rejected');
    expect(result.error).toMatchObject({ code: 'invalid_payload', message: 'lines[0].discountMinr: unknown field in order.create version 4' });
  });

  it('the version gate: /info advertises [1, 2, 3, 4], and a v5 command is unsupported_version naming 4', async () => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, {
      headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).contracts).toEqual({ 'order.create': [1, 2, 3, 4] });
    const counts = async () => ({
      orders: await connection.rawConnection.getRepository(Order).count(),
      commands: await connection.rawConnection.getRepository(TallyCommand).count(),
    });
    const before = await counts();
    const command = { ...fixture('mixed-inclusive'), id: '01a0e775-0100-7000-8000-00000000f005', version: 5 };
    const result = await run(command as unknown as Envelope);
    expect(result.status).toBe('rejected');
    expect(result.error).toMatchObject({ code: 'unsupported_version', data: { orderCreate: 4 } });
    expect(await counts()).toEqual(before);
  });
});
