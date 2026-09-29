import {
  Allocation, DefaultStockLocationStrategy, RequestContextService, StockLevel, StockLocationService, TransactionalConnection,
} from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('VP3-3: Default stock location strategy', () => {
  const environment = createPluginTestEnvironment({ catalogOptions: { stockLocationStrategy: new DefaultStockLocationStrategy() } });
  const { server, variantIds, serviceIds, decode, run } = environment;
  beforeAll(() => environment.init());
  afterAll(() => server.destroy());

  it('7: the top-up follows the first allocation location, even when it is not D', async () => {
    const connection = server.app.get(TransactionalConnection);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const locations = server.app.get(StockLocationService);
    const d = await locations.defaultStockLocation(ctx);
    const x = await locations.create(ctx, { name: 'X' });
    await locations.update(ctx, { id: d.id, name: 'D renamed' });
    expect(String((await locations.getAllStockLocations(ctx.copy()))[0].id)).toBe(String(x.id));
    const variantId = serviceIds.mug[0];
    const levels = connection.rawConnection.getRepository(StockLevel);
    for (const location of [d, x]) {
      const existing = await levels.findOneBy({ productVariantId: variantId, stockLocationId: location.id });
      await levels.save(new StockLevel({ ...existing, productVariantId: variantId, stockLocationId: location.id,
        stockOnHand: 0, stockAllocated: 0 }));
    }
    const state = async () => Object.fromEntries((await levels.find({ where: { productVariantId: variantId } }))
      .map(level => [String(level.stockLocationId), [level.stockOnHand, level.stockAllocated]]));
    expect(await state()).toEqual({ [String(d.id)]: [0, 0], [String(x.id)]: [0, 0] });
    const input = orderCommand([{ variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800 }]);
    const result = await run(input);
    expect(result).toMatchObject({ status: 'applied' });
    const allocations = await connection.rawConnection.getRepository(Allocation).find({
      where: { orderLine: { order: { id: decode(result.serverRefs!.orderId) } } },
    });
    expect(allocations.map(row => [String(row.stockLocationId), row.quantity])).toEqual([[String(x.id), 2]]);
    const ledger = await connection.rawConnection.getRepository(TallyCommand).findOneByOrFail({ id: input.id });
    expect(ledger.topUps).toEqual([{ variantId, stockLocationId: String(allocations[0].stockLocationId), quantity: 2 }]);
    expect(await state()).toEqual({ [String(d.id)]: [0, 0], [String(x.id)]: [-2, 0] });
  });
});
