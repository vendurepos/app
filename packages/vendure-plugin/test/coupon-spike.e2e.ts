import {
  ConfigService, Order, OrderCalculator, OrderLine, ProductVariant, Promotion, PromotionService,
  RequestContext, RequestContextService, TransactionalConnection, User,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type Line = Parameters<typeof orderCommand>[0][number];
const COUPON_MINOR = 600;
// TallyUI 3.20.0 literals from apps/pos/lib/coupon-stacking.test.ts (Q1).
const F1_TILL_TOTAL_MINOR = 6000;
const F2_TILL_TOTAL_MINOR = 5996;
const fixtures = [
  { name: 'F1', unit: 2000, total: F1_TILL_TOTAL_MINOR },
  { name: 'F2', unit: 1999, total: F2_TILL_TOTAL_MINOR },
];

describe('CPN-S: coupon pricing and usage against Vendure', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode, run } = environment;
  let connection: TransactionalConnection;
  let calculator: OrderCalculator;
  let promotionService: PromotionService;
  let ctx: RequestContext;
  let P_CODE: Promotion;
  let P_AUTO: Promotion;
  let P_LIMIT: Promotion;
  let P_CUSTOMER: Promotion;
  const relations = [
    'promotions', 'lines', 'lines.productVariant', 'lines.taxCategory',
    'shippingLines', 'shippingLines.shippingMethod', 'surcharges', 'customer',
  ];

  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    calculator = server.app.get(OrderCalculator);
    promotionService = server.app.get(PromotionService);
    const { superadminCredentials } = server.app.get(ConfigService).authOptions;
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: superadminCredentials.identifier }, relations: ['roles', 'roles.channels'],
    });
    ctx = await server.app.get(RequestContextService).create({ apiType: 'admin', user });
    const promotions: Promotion[] = [];
    for (const definition of [
      { name: 'P_CODE', couponCode: 'SPIKE10', action: 'products_percentage_discount', discount: '10' },
      { name: 'P_AUTO', action: 'order_fixed_discount', discount: '100' },
      { name: 'P_LIMIT', couponCode: 'ONCE', usageLimit: 1, action: 'order_percentage_discount', discount: '10' },
      { name: 'P_CUSTOMER', couponCode: 'MINE', perCustomerUsageLimit: 1, action: 'order_percentage_discount', discount: '10' },
    ]) {
      const created = await adminClient.query<{ createPromotion: { id: string; enabled: boolean } }>(parse(`
        mutation Promotion($input: CreatePromotionInput!) {
          createPromotion(input: $input) { ... on Promotion { id enabled } ... on ErrorResult { message } }
        }
      `), { input: {
        enabled: true, startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
        couponCode: definition.couponCode, usageLimit: definition.usageLimit,
        perCustomerUsageLimit: definition.perCustomerUsageLimit,
        translations: [{ languageCode: 'en', name: definition.name, description: '' }],
        conditions: [{ code: 'minimum_order_amount', arguments: [
          { name: 'amount', value: '0' }, { name: 'taxInclusive', value: 'false' },
        ] }],
        actions: [{ code: definition.action, arguments: [
          { name: 'discount', value: definition.discount },
          ...(definition.name === 'P_CODE' ? [{
            name: 'productVariantIds', value: JSON.stringify([variantIds.mug[0], variantIds.beans[0]]),
          }] : []),
        ] }],
      } });
      expect(created.createPromotion, JSON.stringify(created)).toMatchObject({ enabled: true });
      promotions.push(await connection.getRepository(ctx, Promotion).findOneOrFail({
        where: { id: decode(created.createPromotion.id) }, relations: ['channels'],
      }));
    }
    [P_CODE, P_AUTO, P_LIMIT, P_CUSTOMER] = promotions;
  });
  afterAll(() => server.destroy());

  async function priceUnsaved(ctx: RequestContext, lines: Line[], promotions: Promotion[]) {
    const orders = connection.getRepository(ctx, Order);
    const orderLines = connection.getRepository(ctx, OrderLine);
    const before = [await orders.count(), await orderLines.count()];
    const order = new Order({
      state: 'AddingItems', active: true, currencyCode: ctx.currencyCode, channels: [ctx.channel],
      lines: [], shippingLines: [], surcharges: [], promotions: [], shippingAddress: {}, billingAddress: {},
      couponCodes: promotions.flatMap(promotion => promotion.couponCode ? [promotion.couponCode] : []),
    });
    for (const line of lines) {
      const variant = await connection.getRepository(ctx, ProductVariant).findOneOrFail({
        where: { id: decode(line.variantId!) }, relations: ['taxCategory'],
      });
      // A saved line gets orderPlacedQuantity 0 from its column default; unset, OrderLine.discounts divides by NaN.
      order.lines.push(new OrderLine({
        order, productVariant: variant, productVariantId: variant.id, quantity: line.quantity,
        orderPlacedQuantity: 0,
        listPrice: line.unitPriceMinor, initialListPrice: line.unitPriceMinor,
        listPriceIncludesTax: line.taxInclusive ?? false,
        taxCategory: variant.taxCategory, taxCategoryId: variant.taxCategory.id,
        adjustments: [], taxLines: [],
      }));
    }
    try {
      await calculator.applyPriceAdjustments(ctx, order, promotions);
    } finally {
      expect([await orders.count(), await orderLines.count()]).toEqual(before);
    }
    return {
      order,
      lines: order.lines.map(line => ({
        variantId: String(line.productVariantId),
        adjustments: line.adjustments.filter(adjustment =>
          promotions.some(promotion => adjustment.adjustmentSource === promotion.getSourceId())),
      })),
    };
  }

  for (const { name, unit } of fixtures) {
    for (const pricesIncludeTax of [false, true]) {
      it(`B1: ${name}, pricesIncludeTax=${pricesIncludeTax}, saved and unsaved adjustments agree`, async () => {
        const lines = [
          { variantId: variantIds.mug[0], quantity: 3, unitPriceMinor: unit, taxInclusive: pricesIncludeTax },
          { variantId: variantIds.beans[0], quantity: 2, unitPriceMinor: 500, taxInclusive: pricesIncludeTax },
        ];
        const result = await run(orderCommand(lines, undefined, undefined, { pricesIncludeTax }));
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
        const saved = await connection.getRepository(ctx, Order).findOneOrFail({
          where: { id: decode(result.serverRefs!.orderId) }, relations,
        });
        // The spike payload has no coupons; attach the code only to the in-memory pricing input.
        saved.couponCodes = ['SPIKE10'];
        await calculator.applyPriceAdjustments(ctx, saved, [P_CODE]);
        const unsaved = await priceUnsaved(ctx, lines, [P_CODE]);
        expect(unsaved.lines.length).toBe(2);
        for (const line of unsaved.lines) {
          const savedLine = saved.lines.find(item => String(item.productVariantId) === line.variantId)!;
          const adjustments = savedLine.adjustments.filter(item => item.adjustmentSource === P_CODE.getSourceId());
          expect(line.adjustments.length).toBe(1);
          expect(adjustments.map(item => item.amount)).toEqual(line.adjustments.map(item => item.amount));
        }
      });
    }
  }

  it('B1: a mixed-mode order has the same saved and unsaved adjustments', async () => {
    const lines = [
      { variantId: variantIds.mug[0], quantity: 3, unitPriceMinor: 1999, taxInclusive: true },
      { variantId: variantIds.beans[0], quantity: 2, unitPriceMinor: 500, taxInclusive: false },
    ];
    const result = await run(orderCommand(lines, undefined, undefined, { pricesIncludeTax: false }));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const saved = await connection.getRepository(ctx, Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations,
    });
    saved.couponCodes = ['SPIKE10'];
    await calculator.applyPriceAdjustments(ctx, saved, [P_CODE]);
    const unsaved = await priceUnsaved(ctx, lines, [P_CODE]);
    expect(unsaved.lines.length).toBe(2);
    for (const line of unsaved.lines) {
      const savedLine = saved.lines.find(item => String(item.productVariantId) === line.variantId)!;
      const adjustments = savedLine.adjustments.filter(item => item.adjustmentSource === P_CODE.getSourceId());
      expect(line.adjustments.length).toBe(1);
      expect(adjustments.map(item => item.amount)).toEqual(line.adjustments.map(item => item.amount));
    }
  });

  it('B2: only the listed promotion is applied despite an enabled automatic promotion', async () => {
    expect(P_AUTO.enabled).toBe(true);
    expect(P_AUTO.channels.map(channel => String(channel.id))).toContain(String(ctx.channelId));
    const { order } = await priceUnsaved(ctx, [
      { variantId: variantIds.mug[0], quantity: 3, unitPriceMinor: 2000 },
      { variantId: variantIds.beans[0], quantity: 2, unitPriceMinor: 500 },
    ], [P_CODE]);
    expect(order.lines.flatMap(line => line.adjustments)
      .filter(item => item.adjustmentSource === P_AUTO.getSourceId()).length).toBe(0);
    expect(order.discounts.map(item => ({ source: item.adjustmentSource, amount: item.amount })))
      .toEqual([{ source: P_CODE.getSourceId(), amount: -700 }]);
    expect(order.promotions.map(promotion => String(promotion.id))).toEqual([String(P_CODE.id)]);
  });

  it('B3: a completed POS order consumes the global usage limit', async () => {
    const result = await run(orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 2000 }]));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const saved = await connection.getRepository(ctx, Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations,
    });
    expect(await promotionService.validateCouponCode(ctx, 'ONCE', undefined)).toMatchObject({ id: P_LIMIT.id });
    saved.promotions = [P_LIMIT];
    saved.couponCodes = ['ONCE'];
    await connection.getRepository(ctx, Order).save(saved);
    expect(await promotionService.validateCouponCode(ctx, 'ONCE', undefined))
      .toMatchObject({ errorCode: 'COUPON_CODE_LIMIT_ERROR', couponCode: 'ONCE', limit: 1 });
  });

  it('B3: a completed POS order consumes only its customer\'s usage limit', async () => {
    const customers: string[] = [];
    for (const emailAddress of ['spike-owner@example.com', 'spike-other@example.com']) {
      const created = await adminClient.query<{ createCustomer: { id: string } }>(parse(`
        mutation Customer($input: CreateCustomerInput!) {
          createCustomer(input: $input) { ... on Customer { id } ... on ErrorResult { message } }
        }
      `), { input: { emailAddress, firstName: 'Spike', lastName: 'Customer' } });
      customers.push(created.createCustomer.id);
    }
    const customerId = decode(customers[0]);
    const result = await run(orderCommand(
      [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 2000 }], undefined,
      { customerId: customers[0] },
    ));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const saved = await connection.getRepository(ctx, Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations,
    });
    expect(String(saved.customer!.id)).toBe(customerId);
    expect(await promotionService.validateCouponCode(ctx, 'MINE', customerId)).toMatchObject({ id: P_CUSTOMER.id });
    saved.promotions = [P_CUSTOMER];
    saved.couponCodes = ['MINE'];
    await connection.getRepository(ctx, Order).save(saved);
    expect(await promotionService.validateCouponCode(ctx, 'MINE', customerId))
      .toMatchObject({ errorCode: 'COUPON_CODE_LIMIT_ERROR', couponCode: 'MINE', limit: 1 });
    expect(await promotionService.validateCouponCode(ctx, 'MINE', decode(customers[1])))
      .toMatchObject({ id: P_CUSTOMER.id });
  });

  for (const { name, unit, total } of fixtures) {
    it(`B4: ${name} coupon plus till percentage agrees with TallyUI to the minor unit`, async () => {
      const result = await run(orderCommand([
        { variantId: variantIds.mug[0], quantity: 3, unitPriceMinor: unit, discountMinor: 600 },
      ]));
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
      const saved = await connection.getRepository(ctx, Order).findOneOrFail({
        where: { id: decode(result.serverRefs!.orderId) }, relations,
      });
      expect(saved.surcharges.filter(surcharge => surcharge.sku === 'TALLY-ROUNDING').length).toBe(0);
      expect(saved.surcharges.filter(surcharge => surcharge.sku === 'TALLY-DISCOUNT')
        .map(surcharge => surcharge.listPrice)).toEqual([-600]);
      saved.couponCodes = ['SPIKE10'];
      await calculator.applyPriceAdjustments(ctx, saved, [P_CODE]);
      expect(saved.lines.length).toBe(1);
      expect(saved.lines[0].adjustments.filter(item => item.adjustmentSource === P_CODE.getSourceId())
        .map(item => item.amount)).toEqual([-COUPON_MINOR]);
      expect(saved.totalWithTax).toBe(total);
    });
  }

  it('B5: a lower-case code matches the upper-case promotion (Vendure matches coupon codes case-insensitively)', async () => {
    expect(await promotionService.validateCouponCode(ctx, 'SPIKE10', undefined)).toMatchObject({ id: P_CODE.id });
    expect(await promotionService.validateCouponCode(ctx, 'spike10', undefined))
      .toMatchObject({ id: P_CODE.id });
  });
});
