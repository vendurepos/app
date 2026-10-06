import { Order, TaxCategory, TaxRate, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('order.create v5 contract plumbing', () => {
  const environment = createPluginTestEnvironment();
  const { server, variantIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let category: TaxCategory;
  let standardRate: number;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    category = await connection.rawConnection.getRepository(TaxCategory).findOneByOrFail({ name: 'Standard' });
    standardRate = (await connection.rawConnection.getRepository(TaxRate).findOneOrFail({
      where: { category: { id: category.id }, zone: { name: 'Denmark' } },
    })).value;
  });
  afterAll(() => server.destroy());
  const sale = () => ({ ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]), version: 5 as const });
  const fee = { clientFeeId: 'fee-1', name: 'Handling', amountMinor: 100, taxStatus: 'none' as const, taxMinor: 0 };

  it('applies a plain v5 sale with the same serverRefs total as v4', async () => {
    const v4 = await run({ ...sale(), version: 4 });
    const v5 = await run(sale());
    expect(v4.status).toBe('applied');
    expect(v5.status).toBe('applied');
    expect(v5.serverRefs!.totalMinor).toBe(v4.serverRefs!.totalMinor);
  });

  it('refuses fees below v5, naming the required version', async () => {
    const command = { ...sale(), version: 4 as const };
    command.payload.fees = [fee];
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(result.error!.message).toContain('fees: requires order.create version 5');
  });

  for (const taxClassMode of ['default', 'none', 'name', 'trimmed-name', 'id', 'unknown'] as const) {
    it(`honours a v5 Bag fee with ${taxClassMode} tax class, or refuses an unknown class`, async () => {
      const command = { ...orderCommand([{
        variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000,
      }]), version: 5 as const };
      const payload = command.payload;
      const productTotal = payload.totalMinor;
      const taxable = taxClassMode !== 'none';
      const feeTax = taxable ? Math.round(20 * standardRate / 100) : 0;
      const taxClass = taxClassMode === 'name' ? category.name
        : taxClassMode === 'trimmed-name' ? ` ${category.name.toUpperCase()} `
        : taxClassMode === 'id' ? String(category.id)
        : taxClassMode === 'unknown' ? 'missing-tax-category' : undefined;
      payload.fees = [{ ...fee, name: 'Bag', amountMinor: 20, taxStatus: taxable ? 'taxable' : 'none', taxMinor: feeTax, taxClass }];
      payload.taxMinor += feeTax;
      payload.totalMinor += 20 + feeTax;
      payload.payments[0].amountMinor = payload.totalMinor;
      payload.display!.fees = [{ clientFeeId: fee.clientFeeId, amountMinor: 20 }];
      payload.display!.taxMinor = payload.taxMinor;
      payload.display!.totalMinor = payload.totalMinor;
      if (taxable) {
        payload.taxByRate![0].netMinor += 20;
        payload.taxByRate![0].taxMinor += feeTax;
        payload.taxByRate![0].grossMinor += 20 + feeTax;
      } else {
        payload.taxByRate!.push({ ratePpm: 0, netMinor: 20, taxMinor: 0, grossMinor: 20 });
      }
      const result = await run(command);
      if (taxClassMode === 'unknown') {
        expect(result).toMatchObject({ status: 'rejected', error: {
          code: 'invalid_payload', data: { reason: 'tax_class_unknown', path: 'fees[0].taxClass' },
        } });
        expect(result.error!.message).toContain('fees[0].taxClass');
        expect(result.error!.message).toContain('tax_class_unknown');
        return;
      }
      expect(result.status).toBe('applied');
      expect(result.serverRefs!.totalMinor).toBe(payload.totalMinor);
      expect(result.warnings?.some(warning => warning.code === 'figures_mismatch')).not.toBe(true);
      expect(result.totalWarnings ?? []).toEqual([]);
      const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
        where: { id: decode(result.serverRefs!.orderId) }, relations: ['surcharges'],
      });
      expect(order.totalWithTax).toBe(productTotal + 20 + feeTax);
      const surcharges = order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-FEE');
      expect(surcharges).toHaveLength(1);
      expect(surcharges[0]).toMatchObject({ listPrice: 20, description: 'Bag', listPriceIncludesTax: false });
      expect(surcharges[0].taxLines.map(line => line.taxRate)).toEqual(taxable ? [standardRate] : []);
      if (taxClassMode === 'default') {
        const replay = await run(command);
        expect(replay.status).toBe('duplicate');
        expect(replay.serverRefs).toEqual(result.serverRefs);
      }
    });
  }

  it('refuses a v5 custom line without a variantId until the server honours it', async () => {
    const command = sale();
    command.payload.lines.push({ clientLineId: 'custom-1', quantity: 1, unitPriceMinor: 100, custom: { name: 'Custom', taxStatus: 'none' } });
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: {
      code: 'invalid_payload', message: 'lines[1].custom: not supported by this server yet',
    } });
  });

  it('refuses a custom line that also has a variantId', async () => {
    const command = sale();
    command.payload.lines[0].custom = { name: 'Custom', taxStatus: 'none' };
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(result.error!.message).toContain('lines[0].variantId: expected no variantId on a custom line');
  });

  it('refuses negative and fractional fee amounts, naming their path', async () => {
    for (const amountMinor of [-1, 1.5]) {
      const command = sale();
      command.payload.fees = [{ ...fee, amountMinor }];
      const result = await run(command);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain('fees[0].amountMinor: expected a non-negative integer');
    }
  });

  it('refuses duplicate clientShippingIds', async () => {
    const command = sale();
    const shipping = { clientShippingId: 'shipping-1', name: 'Delivery', amountMinor: 100, taxStatus: 'none' as const, taxMinor: 0 };
    command.payload.shipping = [shipping, { ...shipping }];
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(result.error!.message).toContain('shipping[1].clientShippingId: expected no duplicate clientShippingId');
  });
});
