import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('order.create v5 contract plumbing', () => {
  const environment = createPluginTestEnvironment();
  const { server, variantIds, run } = environment;
  beforeAll(() => environment.init());
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

  it('refuses v5 fees until the server honours them', async () => {
    const command = sale();
    command.payload.fees = [fee];
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: {
      code: 'invalid_payload', message: 'payload.fees: not supported by this server yet',
    } });
  });

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
