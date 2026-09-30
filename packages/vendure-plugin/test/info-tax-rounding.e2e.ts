import {
  DefaultMoneyStrategy, DefaultOrderTaxCalculationStrategy, DefaultTaxLineCalculationStrategy, OrderLevelTaxCalculationStrategy,
} from '@vendure/core';
import type { Order, OrderTaxCalculationStrategy } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaxRounding } from '../src/service/tax-rounding';
import { createPluginTestEnvironment } from './env';

// Each rounds exactly as its parent, but is not the class /info can describe, so each is custom.
class RoundedOrderLevelTax extends OrderLevelTaxCalculationStrategy {}
class OwnOrderTax implements OrderTaxCalculationStrategy {
  private readonly inner = new DefaultOrderTaxCalculationStrategy();
  calculateOrderTotals(order: Order) { return this.inner.calculateOrderTotals(order); }
  calculateTaxSummary(order: Order) { return this.inner.calculateTaxSummary(order); }
}
class OwnMoney extends DefaultMoneyStrategy {}
class OwnTaxLines extends DefaultTaxLineCalculationStrategy {}

const custom = { granularity: 'custom' } as const;
const cases: Array<[string, Parameters<typeof createPluginTestEnvironment>[0], TaxRounding]> = [
  ['the default tax strategy', {}, { granularity: 'per_line_items', mode: 'half_up' }],
  ['OrderLevelTaxCalculationStrategy', { taxOptions: { orderTaxCalculationStrategy: new OrderLevelTaxCalculationStrategy() } },
    { granularity: 'per_rate_group_items', mode: 'half_up' }],
  ['a subclass of OrderLevelTaxCalculationStrategy', { taxOptions: { orderTaxCalculationStrategy: new RoundedOrderLevelTax() } }, custom],
  ['an unrelated custom order tax strategy', { taxOptions: { orderTaxCalculationStrategy: new OwnOrderTax() } }, custom],
  ['a custom money strategy', { entityOptions: { moneyStrategy: new OwnMoney() } }, custom],
  ['a custom tax line strategy', { taxOptions: { taxLineCalculationStrategy: new OwnTaxLines() } }, custom],
];

for (const [name, override, taxRounding] of cases) {
  describe(`GET /tally/v1/info with ${name}`, () => {
    const environment = createPluginTestEnvironment(override);
    const { server, adminClient } = environment;
    beforeAll(() => environment.init());
    afterAll(() => server.destroy());

    it(`advertises taxRounding ${JSON.stringify(taxRounding)} beside unchanged contracts`, async () => {
      const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, {
        headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      // Never absent, and `custom` carries no mode: exact keys, not just a matching shape.
      expect(Object.keys(body)).toEqual(['contracts', 'taxRounding']);
      expect(Object.keys(body.taxRounding).sort()).toEqual(Object.keys(taxRounding).sort());
      expect(body).toEqual({ contracts: { 'order.create': [1, 2, 3] }, taxRounding });
    });
  });
}
