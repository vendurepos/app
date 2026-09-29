import { ConfigService, Order, TransactionalConnection } from '@vendure/core';
import type { OrderItemPriceCalculationStrategy, ProductVariant } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyPriceStrategy } from '../src';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';
import { guestOrder } from './shop';

// A merchant's own strategy: storefront prices doubled, with a lifecycle the wrapper must forward.
class DoublingStrategy implements OrderItemPriceCalculationStrategy {
  inits = 0;
  destroys = 0;
  init() { this.inits += 1; }
  destroy() { this.destroys += 1; }
  calculateUnitPrice(_ctx: unknown, variant: ProductVariant) {
    return { price: variant.listPrice * 2, priceIncludesTax: variant.listPriceIncludesTax };
  }
}

describe('review 7: the merchant\'s price strategy keeps pricing everything but POS lines', () => {
  const doubling = new DoublingStrategy();
  const environment = createPluginTestEnvironment({ orderOptions: { orderItemPriceCalculationStrategy: doubling } });
  const { server, shopClient, variantIds, decode, run } = environment;
  beforeAll(() => environment.init());
  afterAll(async () => {
    await server.destroy();
    expect(doubling.destroys).toBe(doubling.inits);
  });

  it('wraps the configured strategy once and forwards init', () => {
    const configured = server.app.get(ConfigService).orderOptions.orderItemPriceCalculationStrategy;
    expect(configured).toBeInstanceOf(TallyPriceStrategy);
    expect((configured as TallyPriceStrategy).inner).toBe(doubling);
    // TestServer.init also boots a short-lived app to populate the database, so count live inits.
    expect(doubling.inits).toBeGreaterThan(0);
    expect(doubling.inits - doubling.destroys).toBe(1);
  });

  it('a storefront line is doubled by the merchant strategy; a POS line keeps its as-sold price', async () => {
    const shop = await guestOrder(shopClient, variantIds.mug[0], 'vp1-price@example.com');
    expect(shop.added).toMatchObject({ state: 'AddingItems', totalWithTax: 2000 });
    const result = await run(orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 1000 } });
    const order = await server.app.get(TransactionalConnection).rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines'],
    });
    expect(order.lines.map(line => [line.unitPrice, line.unitPriceWithTax])).toEqual([[800, 1000]]);
    expect(order.totalWithTax).toBe(1000);
  });
});
