// Fixture: apps/pos/lib/discount-total-matrix.test.ts. After a TallyUI bump, regenerate with
// pnpm vitest run apps/pos/lib/discount-total-matrix.test.ts -u
// The till sends no coupons (connector-vendure has no coupon path); promotions are the Vendure-side half.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { createPluginTestEnvironment } from './env';

type Envelope = CommandEnvelope<OrderCreatePayload>;
const fixture = readFileSync(join(__dirname, 'fixtures/discount-matrix.json'), 'utf8');

function freshId() {
  const uuid = randomUUID();
  return uuid.slice(0, 14) + '7' + uuid.slice(15);
}

export function discountMatrixCases(
  strategy: 'default' | 'order-level',
  granularity: 'per_line_items' | 'per_rate_group_items',
  override: Parameters<typeof createPluginTestEnvironment>[0] = {},
) {
  describe(`till discount matrix: ${strategy}`, () => {
    const environment = createPluginTestEnvironment(override);
    const { server, adminClient, variantIds, decode, run } = environment;
    const keys = Object.keys(JSON.parse(fixture)).filter(key => key.startsWith(`${granularity}/`));
    const promotionIds: string[] = [];
    let connection: TransactionalConnection;
    let channelId: string;
    let germanyId: string;

    beforeAll(async () => {
      await environment.init();
      connection = server.app.get(TransactionalConnection);
      const setup = await adminClient.query<{
        activeChannel: { id: string }; zones: { items: Array<{ id: string; name: string }> };
      }>(parse('query { activeChannel { id } zones { items { id name } } }'));
      channelId = setup.activeChannel.id;
      germanyId = setup.zones.items.find(zone => zone.name === 'Germany')!.id;
    });

    afterAll(async () => {
      for (const id of promotionIds) {
        await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
          updatePromotion(input: $input) { ... on Promotion { id enabled } }
        }`), { input: { id, enabled: false } });
      }
      await server.destroy();
    });

    async function setMode(pricesIncludeTax: boolean) {
      const updated = await adminClient.query<{ updateChannel: { pricesIncludeTax: boolean } }>(parse(`
        mutation Mode($input: UpdateChannelInput!) {
          updateChannel(input: $input) { ... on Channel { pricesIncludeTax } }
        }
      `), { input: { id: channelId, pricesIncludeTax, defaultTaxZoneId: germanyId, defaultShippingZoneId: germanyId } });
      expect(updated.updateChannel.pricesIncludeTax).toBe(pricesIncludeTax);
    }

    for (const promotionState of ['none', 'promotions'] as const) {
      for (const key of keys) {
        it(`${promotionState}: ${key}`, async () => {
          // Both promotions remain enabled together for the second half of the matrix.
          if (promotionState === 'promotions' && key === keys[0]) {
            for (const promotion of [
              { code: 'order_percentage_discount', discount: '10', couponCode: null },
              { code: 'order_fixed_discount', discount: '500', couponCode: 'TILL10' },
            ]) {
              const created = await adminClient.query<{
                createPromotion: { id: string; enabled: boolean; couponCode: string | null };
              }>(parse(`mutation Promotion($input: CreatePromotionInput!) {
                createPromotion(input: $input) {
                  ... on Promotion { id enabled couponCode } ... on ErrorResult { message }
                }
              }`), { input: {
                enabled: true, startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
                ...(promotion.couponCode ? { couponCode: promotion.couponCode } : {}),
                translations: [{ languageCode: 'en', name: `Discount matrix ${promotion.code}`, description: '' }],
                conditions: [{ code: 'minimum_order_amount', arguments: [
                  { name: 'amount', value: '0' }, { name: 'taxInclusive', value: 'false' },
                ] }],
                actions: [{ code: promotion.code, arguments: [{ name: 'discount', value: promotion.discount }] }],
              } });
              promotionIds.push(created.createPromotion.id);
              expect(created.createPromotion, JSON.stringify(created)).toMatchObject({
                enabled: true, couponCode: promotion.couponCode,
              });
            }
          }

          const commands: Record<string, Envelope> = JSON.parse(fixture
            .replaceAll('"VARIANT_STANDARD"', JSON.stringify(variantIds.mug[0]))
            .replaceAll('"VARIANT_REDUCED"', JSON.stringify(variantIds.beans[0])));
          const command = commands[key];
          const { payload } = command;
          command.id = freshId();
          payload.clientOrderId = freshId();
          for (const payment of payload.payments) payment.clientPaymentId = freshId();
          await setMode(key.split('/')[1] === 'inclusive');

          expect(payloadShapeErrors(payload)).toEqual([]);
          expect(fiscalFiguresErrors(payload)).toEqual([]);
          const result = await run(command);
          const diagnostic = JSON.stringify({ key, promotionState, expectedTotalMinor: payload.totalMinor, result });
          expect(result, diagnostic).toMatchObject({ status: 'applied' });
          expect(result.totalWarnings, diagnostic).toBeUndefined();
          expect(result.serverRefs!.totalMinor, diagnostic).toBe(payload.totalMinor);
          const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
            where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines', 'surcharges', 'payments', 'promotions'],
          });
          expect(order.totalWithTax, diagnostic).toBe(payload.totalMinor);
          expect(order.payments.reduce((sum, payment) => sum + payment.amount, 0), diagnostic).toBe(payload.totalMinor);
          expect(payload.payments.reduce((sum, payment) => sum + payment.amountMinor, 0), diagnostic).toBe(payload.totalMinor);
          expect(order.subTotal, diagnostic).toBe(payload.subtotalMinor);
          expect(order.promotions).toEqual([]);
          expect(order.discounts).toEqual([]);
          expect(order.couponCodes).toEqual([]);
          expect(order.surcharges.some(surcharge => surcharge.sku === 'TALLY-ROUNDING')).toBe(false);
          expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-DISCOUNT')
            .reduce((sum, surcharge) => sum + surcharge.listPrice, 0)).toBe(0 - (payload.discountMinor ?? 0));
          expect(order.state).toBe('Delivered');
        });
      }
    }
  });
}
