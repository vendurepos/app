import { ConfigService, Order, OrderService, PaymentService, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/vendored/commands';
import { OrderCreateService } from '../src/plugin/order-create.service';
import { createS1TestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('proof 2: automatic promotions are removed from POS orders', () => {
  const environment = createS1TestEnvironment();
  const { server, adminClient, variantIds } = environment;
  let connection: TransactionalConnection;
  let recipe: OrderCreateService;
  const relations = ['promotions', 'lines', 'shippingLines', 'surcharges', 'payments', 'fulfillments'];
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    recipe = server.app.get(OrderCreateService);
    const ids = server.app.get(ConfigService).entityOptions.entityIdStrategy;
    for (const variants of Object.values(variantIds)) {
      variants.splice(0, variants.length, ...variants.map(id => String(ids.decodeId(id))));
    }
  });
  afterAll(() => server.destroy());

  function snapshot(call: string, order: Order) {
    return {
      call, promotions: order.promotions.map(promotion => String(promotion.id)),
      discounts: order.discounts.map(discount => ({ type: discount.type, amount: discount.amount })),
      adjustments: order.lines.map(line => line.adjustments.map(adjustment => ({
        type: adjustment.type, amount: adjustment.amount,
      }))),
      surcharges: order.surcharges.map(row => ({ sku: row.sku, listPrice: row.listPrice })),
      total: order.totalWithTax, payments: order.payments.map(payment => payment.amount), state: order.state,
    };
  }

  for (const action of [
    { code: 'order_percentage_discount', discount: '10' },
    { code: 'order_line_fixed_discount', discount: '50' },
  ]) {
    it(`${action.code}: PaymentService.createPayment (no addPaymentToOrder) keeps promotions empty after payments and delivery`, async () => {
      const created = await adminClient.query<{ createPromotion: { id: string; enabled: boolean; couponCode: string | null } }>(parse(`
        mutation Promotion($input: CreatePromotionInput!) {
          createPromotion(input: $input) { ... on Promotion { id enabled couponCode } ... on ErrorResult { message } }
        }
      `), { input: {
        enabled: true, startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
        translations: [{ languageCode: 'en', name: `S1 ${action.code}`, description: '' }],
        conditions: [{ code: 'minimum_order_amount', arguments: [
          { name: 'amount', value: '0' }, { name: 'taxInclusive', value: 'false' },
        ] }],
        actions: [{ code: action.code, arguments: [{ name: 'discount', value: action.discount }] }],
      } });
      expect(created.createPromotion, JSON.stringify(created)).toMatchObject({ enabled: true, couponCode: null });
      const promotionId = String(server.app.get(ConfigService).entityOptions.entityIdStrategy.decodeId(created.createPromotion.id));
      const observations: ReturnType<typeof snapshot>[] = [];
      recipe.testObserver = async (stage, ctx, order) => {
        const saved = await connection.getRepository(ctx, Order).findOneOrFail({ where: { id: order.id }, relations });
        observations.push(snapshot(stage, saved));
      };
      // Spies call the real Vendure methods; there is no mocked pricing or payment boundary.
      const createPayment = vi.spyOn(server.app.get(PaymentService), 'createPayment');
      const addPayment = vi.spyOn(server.app.get(OrderService), 'addPaymentToOrder');
      const addSurcharge = vi.spyOn(server.app.get(OrderService), 'addSurchargeToOrder');
      try {
        const lines = [
          { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 1000, discountMinor: 50 },
          { variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 500 },
        ];
        const total = orderCommand(lines).payload.totalMinor;
        const command = orderCommand(lines, [
          { method: 'cash', amountMinor: 100 }, { method: 'external', amountMinor: total - 100 },
        ]);
        const response = await fetch(`${await server.app.getUrl()}/tally/v1/commands`, {
          method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-Tally-Protocol': '1',
            Authorization: `Bearer ${adminClient.getAuthToken()}`,
          }, body: JSON.stringify({ commands: [command] }),
        });
        const body = await response.json() as { results: CommandResult[] };
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.results[0], JSON.stringify(body)).toMatchObject({ status: 'applied' });
        const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
          where: { id: body.results[0].serverRefs!.orderId }, relations,
        });
        observations.push(snapshot('afterFulfilmentReload', order));
        console.log('S1-NUM', JSON.stringify({
          proof: 2, action: action.code, observations,
          createPaymentCalls: createPayment.mock.calls.length, addPaymentToOrderCalls: addPayment.mock.calls.length,
          addSurchargeToOrderCalls: addSurcharge.mock.calls.length,
        }));
        expect(observations.map(row => row.call)).toEqual([
          'addItemToOrder', 'addItemToOrder', 'setShippingMethod', 'surchargeSave',
          'finalPass', 'payments', 'afterFulfilmentReload',
        ]);
        for (const row of observations.slice(0, 4)) {
          expect(row.promotions, row.call).toEqual([promotionId]);
          expect(row.discounts.length, row.call).toBeGreaterThan(0);
          expect(row.adjustments.flat().some(adjustment => adjustment.amount < 0), row.call).toBe(true);
        }
        // A repository save retains the previous promotion; it is not a re-pricing call.
        expect(observations[3].discounts).toEqual(observations[2].discounts);
        expect(observations[3].surcharges).toEqual([{ sku: 'TALLY-DISCOUNT', listPrice: -50 }]);
        for (const row of observations.slice(4)) {
          expect(row.promotions, row.call).toEqual([]);
          expect(row.discounts, row.call).toEqual([]);
          expect(row.adjustments, row.call).toEqual([[], []]);
          expect(row.total, row.call).toBe(command.payload.totalMinor);
        }
        expect(createPayment).toHaveBeenCalledTimes(2);
        expect(addPayment).not.toHaveBeenCalled();
        expect(addSurcharge).not.toHaveBeenCalled();
        expect(observations[5].payments.reduce((sum, amount) => sum + amount, 0)).toBe(total);
        expect(order.state).toBe('Delivered');
        expect(order.fulfillments.map(fulfillment => fulfillment.state)).toEqual(['Delivered']);
      } finally {
        recipe.testObserver = undefined;
        createPayment.mockRestore();
        addPayment.mockRestore();
        addSurcharge.mockRestore();
        await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
          updatePromotion(input: $input) { ... on Promotion { id enabled } }
        }`), { input: { id: created.createPromotion.id, enabled: false } });
      }
    });
  }
});
