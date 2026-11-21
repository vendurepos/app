import { randomUUID } from 'node:crypto';
import {
  defaultPromotionActions, LanguageCode, Order, OrderCalculator, OrderLine, Promotion, PromotionItemAction, PromotionService,
  RequestContext, RequestContextService, Surcharge, TransactionalConnection,
} from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POS_TILL_PERMISSIONS } from '../src';
import type { CouponPricingInput } from '../src/service/coupon-pricing';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

const sideEffectAction = new PromotionItemAction({
  code: 'test_side_effect', args: {},
  description: [{ languageCode: LanguageCode.en, value: 'Test side effect' }],
  execute: () => 0, onActivate: () => {},
});

describe('CPN-1: POST /tally/v1/coupons/price', () => {
  const environment = createPluginTestEnvironment({
    promotionOptions: { promotionActions: [...defaultPromotionActions, sideEffectAction] },
  });
  const { server, adminClient, variantIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  let ctx: RequestContext;
  let cpn10: string;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    cpn10 = await promotion('CPN10');
  });
  afterAll(() => server.destroy());

  const call = async (path: string, body?: unknown, method = 'POST', headers: Record<string, string> = {}) => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminClient.getAuthToken()}`, 'X-Tally-Protocol': '1', ...headers } });
    return { status: response.status, body: await response.json() };
  };
  const tokenWith = async (permissions: string[]) => {
    const { activeChannel } = await adminClient.query(parse('query { activeChannel { id } }')), emailAddress = `${randomUUID()}@till.example`;
    const { createRole } = await adminClient.query(parse('mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }'),
      { input: { code: `cpn1-${randomUUID()}`, description: 'CPN-1', permissions, channelIds: [activeChannel.id] } });
    await adminClient.query(parse('mutation($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }'),
      { input: { firstName: 'Till', lastName: 'CPN-1', emailAddress, password: 'till-password', roleIds: [createRole.id] } });
    const login = await fetch(`${await server.app.getUrl()}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { login(username: "${emailAddress}", password: "till-password") { ... on CurrentUser { id } } }` }) });
    return { Authorization: `Bearer ${login.headers.get('vendure-auth-token')}` };
  };
  const price = (body: unknown, headers?: Record<string, string>) => call('coupons/price', body, 'POST', headers);
  const sale = (codes = ['cpn10']): CouponPricingInput => ({
    currency: 'EUR', pricesIncludeTax: false, codes,
    lines: [
      { clientLineId: 'l1', variantId: variantIds.mug[0], quantity: 3, unitPriceMinor: 2000 },
      { clientLineId: 'l2', variantId: variantIds.beans[0], quantity: 2, unitPriceMinor: 500 },
    ],
  });
  const minimum = (amount: string) => [{ code: 'minimum_order_amount', arguments: [
    { name: 'amount', value: amount }, { name: 'taxInclusive', value: 'false' },
  ] }];
  const percentage = (ids = [variantIds.mug[0]], discount = '10') => [{
    code: 'products_percentage_discount', arguments: [
      { name: 'discount', value: discount }, { name: 'productVariantIds', value: JSON.stringify(ids) },
    ],
  }];
  async function promotion(couponCode: string | null, overrides: Record<string, unknown> = {}) {
    const input = {
      enabled: true, couponCode, startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
      translations: [{ languageCode: 'en', name: `CPN-1 ${couponCode ?? 'automatic'}`, description: '' }],
      conditions: [], actions: percentage(), ...overrides,
    };
    const created = await adminClient.query<{ createPromotion: { id: string; enabled: boolean; couponCode: string | null } }>(parse(`
      mutation Promotion($input: CreatePromotionInput!) {
        createPromotion(input: $input) { ... on Promotion { id enabled couponCode } ... on ErrorResult { message } }
      }
    `), { input });
    expect(created.createPromotion, JSON.stringify(created)).toEqual({ id: expect.any(String), enabled: input.enabled, couponCode });
    return created.createPromotion.id;
  }
  const priced = (key: string, id: string, code: string, lines = [{ lineId: 'l1', amountMinor: 600 }]) => ({
    status: 200, body: { priced: { [key]: { couponId: id, code, lines } } },
  });
  const refused = (message: string) => ({ status: 200, body: { refusal: message } });

  it('answers with the store spelling, encoded coupon id, and only the discounted line', async () => {
    expect(await price(sale())).toEqual(priced('cpn10', cpn10, 'CPN10'));
  });

  it('prices inclusive lines in their own tax mode', async () => {
    // Vendure's products_percentage_discount reads ctx.channel.pricesIncludeTax (product-percentage-discount-action.js:28):
    // on this tax-exclusive channel a gross-priced 2000 line is discounted 10% of its net 1600, x3 = 480, which the
    // line, in gross mode, reads as gross. The saved order gets the same figure (spike CPN-S B1, mixed mode).
    expect(await price({ ...sale(), pricesIncludeTax: true })).toEqual(priced('cpn10', cpn10, 'CPN10', [{ lineId: 'l1', amountMinor: 480 }]));
  });

  it('keeps both lines and safe integers with a minimum-order condition (orderPlacedQuantity NaN pin)', async () => {
    const id = await promotion('BOTH10', {
      conditions: minimum('1'), actions: percentage([variantIds.mug[0], variantIds.beans[0]]),
    });
    const answer = await price(sale(['both10']));
    expect(answer).toEqual(priced('both10', id, 'BOTH10', [
      { lineId: 'l1', amountMinor: 600 }, { lineId: 'l2', amountMinor: 100 },
    ]));
    for (const line of answer.body.priced.both10.lines) expect(Number.isSafeInteger(line.amountMinor)).toBe(true);
  });

  it("a till discount that takes the subtotal below a coupon's minimum makes it not apply", async () => {
    const id = await promotion('MIN6500', { conditions: minimum('6500') });
    try {
      expect(await price(sale(['min6500']))).toEqual(priced('min6500', id, 'MIN6500'));
      const input = sale(['min6500']);
      input.lines[0].discountMinor = 1000;
      expect(await price(input)).toEqual(refused("Coupon min6500 doesn't apply to this sale"));
    } finally {
      const { updatePromotion } = await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
        updatePromotion(input: $input) { ... on Promotion { id enabled } }
      }`), { input: { id, enabled: false } });
      expect(updatePromotion).toEqual({ id, enabled: false });
    }
  });

  it('prices an order discount after the till discount, to the minor unit of the saved order', async () => {
    const id = await promotion('ORDERPCT', {
      conditions: minimum('0'),
      actions: [{ code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] }],
    });
    try {
      const input = sale(['orderpct']);
      input.lines[0].discountMinor = 1000;
      const answer = await price(input);
      const result = await run(orderCommand([
        { variantId: variantIds.mug[0], quantity: 3, unitPriceMinor: 2000, discountMinor: 1000 },
        { variantId: variantIds.beans[0], quantity: 2, unitPriceMinor: 500 },
      ]));
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
      const order = await connection.getRepository(ctx, Order).findOneOrFail({
        where: { id: decode(result.serverRefs!.orderId) }, relations: ['promotions', 'lines', 'lines.productVariant', 'lines.taxCategory', 'shippingLines', 'shippingLines.shippingMethod', 'surcharges', 'customer'],
      });
      const savedPromotion = (await server.app.get(PromotionService).findOne(ctx, decode(id)))!;
      await server.app.get(OrderCalculator).applyPriceAdjustments(ctx, order, [savedPromotion]);
      const amounts = [variantIds.mug[0], variantIds.beans[0]].map(variantId => {
        const line = order.lines.find(item => String(item.productVariant.id) === decode(variantId))!;
        return line.discounts.filter(discount => discount.adjustmentSource === savedPromotion.getSourceId())
          .reduce((sum, discount) => sum - discount.amount, 0);
      });
      expect(answer).toEqual(priced('orderpct', id, 'ORDERPCT', [
        { lineId: 'l1', amountMinor: amounts[0] }, { lineId: 'l2', amountMinor: amounts[1] },
      ]));
      expect(amounts[0] + amounts[1]).toBe(600);
    } finally {
      const { updatePromotion } = await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
        updatePromotion(input: $input) { ... on Promotion { id enabled } }
      }`), { input: { id, enabled: false } });
      expect(updatePromotion).toEqual({ id, enabled: false });
    }
  });

  it('prices buy_x_get_y_free on the free line only', async () => {
    const id = await promotion('FREEBEANS', {
      conditions: [{ code: 'buy_x_get_y_free', arguments: [
        { name: 'amountX', value: '2' }, { name: 'variantIdsX', value: JSON.stringify([variantIds.mug[0]]) },
        { name: 'amountY', value: '1' }, { name: 'variantIdsY', value: JSON.stringify([variantIds.beans[0]]) },
      ] }],
      actions: [{ code: 'buy_x_get_y_free', arguments: [] }],
    });
    try {
      expect(await price(sale(['freebeans']))).toEqual(priced('freebeans', id, 'FREEBEANS', [{ lineId: 'l2', amountMinor: 500 }]));
    } finally {
      const { updatePromotion } = await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
        updatePromotion(input: $input) { ... on Promotion { id enabled } }
      }`), { input: { id, enabled: false } });
      expect(updatePromotion).toEqual({ id, enabled: false });
    }
  });

  it('distributes an order discount across a product and a tax-free custom line', async () => {
    const id = await promotion('CUSTOM10', {
      conditions: minimum('0'),
      actions: [{ code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] }],
    });
    const input = sale(['custom10']);
    input.lines[1] = { clientLineId: 'l2', custom: { name: 'Custom item', taxStatus: 'none' }, quantity: 1, unitPriceMinor: 1000 };
    // Vendure's order_percentage_discount takes 10% of subTotal (net 6000 + 1000 = 7000, so 700) and spreads it by
    // gross line weight (7500 : 1000): 617.6 -> 618 and 82.4 -> 82.
    const answer = await price(input);
    expect(answer).toEqual(priced('custom10', id, 'CUSTOM10', [
      { lineId: 'l1', amountMinor: 618 }, { lineId: 'l2', amountMinor: 82 },
    ]));
    expect(answer.body.priced.custom10.lines[0].amountMinor + answer.body.priced.custom10.lines[1].amountMinor).toBe(700);
  });

  it('prices two codes together and keeps their sent order', async () => {
    const id = await promotion('SECOND5', { actions: percentage([variantIds.mug[0]], '5') });
    const answer = await price(sale(['cpn10', 'second5']));
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body.priced)).toEqual(['cpn10', 'second5']);
    for (const [code, couponId, spelling] of [['cpn10', cpn10, 'CPN10'], ['second5', id, 'SECOND5']]) {
      expect(answer.body.priced[code]).toEqual({ couponId, code: spelling, lines: [{ lineId: 'l1', amountMinor: expect.any(Number) }] });
      const amount = answer.body.priced[code].lines[0].amountMinor;
      expect(Number.isSafeInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
    }
  });

  it('prices several codes in Vendure\'s priority order, whatever order they are sent in', async () => {
    const pct10 = await promotion('PCT10', {
      conditions: minimum('0'),
      actions: [{ code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] }],
    });
    const fixed500 = await promotion('FIXED500', {
      conditions: [], actions: [{ code: 'order_fixed_discount', arguments: [{ name: 'discount', value: '500' }] }],
    });
    try {
      for (const codes of [['pct10', 'fixed500'], ['fixed500', 'pct10']]) {
        const answer = await price(sale(codes));
        expect(answer.status).toBe(200);
        expect(Object.keys(answer.body.priced)).toEqual(codes);
        for (const [code, amount] of [['pct10', 650], ['fixed500', 500]] as const) {
          expect(answer.body.priced[code].lines.reduce((sum: number, line: { amountMinor: number }) => sum + line.amountMinor, 0)).toBe(amount);
        }
      }
    } finally {
      for (const id of [pct10, fixed500]) {
        const { updatePromotion } = await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
          updatePromotion(input: $input) { ... on Promotion { id enabled } }
        }`), { input: { id, enabled: false } });
        expect(updatePromotion).toEqual({ id, enabled: false });
      }
    }
  });

  it('excludes an enabled automatic promotion', async () => {
    const order10 = await promotion('ORDER10', {
      conditions: minimum('0'),
      actions: [{ code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] }],
    });
    const before = await price(sale(['order10']));
    expect(before.status).toBe(200);
    const id = await promotion(null, { conditions: minimum('0'), actions: percentage([variantIds.mug[0]], '50') });
    try {
      expect(await price(sale())).toEqual(priced('cpn10', cpn10, 'CPN10'));
      // An order-level coupon is computed on a subTotal that already has line promotions taken off: had the automatic
      // 50% been priced alongside it, its amounts would shrink.
      expect(await price(sale(['order10']))).toEqual(before);
    } finally {
      const { updatePromotion } = await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
        updatePromotion(input: $input) { ... on Promotion { id enabled } }
      }`), { input: { id, enabled: false } });
      expect(updatePromotion).toEqual({ id, enabled: false });
      const { updatePromotion: updateOrderPromotion } = await adminClient.query(parse(`mutation Disable($input: UpdatePromotionInput!) {
        updatePromotion(input: $input) { ... on Promotion { id enabled } }
      }`), { input: { id: order10, enabled: false } });
      expect(updateOrderPromotion).toEqual({ id: order10, enabled: false });
    }
  });

  it('refuses an unknown code', async () => {
    expect(await price(sale(['unknown']))).toEqual(refused("Coupon unknown isn't valid"));
  });

  it('refuses a disabled promotion', async () => {
    await promotion('DISABLED', { enabled: false });
    expect(await price(sale(['disabled']))).toEqual(refused("Coupon disabled isn't valid"));
  });

  it('refuses an expired promotion', async () => {
    await promotion('EXPIRED', { endsAt: '2021-01-01T00:00:00.000Z' });
    expect(await price(sale(['expired']))).toEqual(refused("Coupon expired isn't valid"));
  });

  it('refuses a promotion whose start is in the future', async () => {
    await promotion('FUTURE', { startsAt: '2098-01-01T00:00:00.000Z' });
    expect(await price(sale(['future']))).toEqual(refused("Coupon future isn't valid"));
  });

  it('refuses an unmet minimum-order condition', async () => {
    await promotion('MINIMUM', { conditions: minimum('1000000') });
    expect(await price(sale(['minimum']))).toEqual(refused("Coupon minimum doesn't apply to this sale"));
  });

  it('refuses a promotion with no matching line', async () => {
    await promotion('BEANS10', { actions: percentage([variantIds.beans[0]]) });
    const input = sale(['beans10']);
    input.lines = input.lines.slice(0, 1);
    expect(await price(input)).toEqual(refused("Coupon beans10 doesn't apply to this sale"));
  });

  it('refuses shipping-only promotions', async () => {
    await promotion('SHIPPING', { actions: [{ code: 'free_shipping', arguments: [] }] });
    expect(await price(sale(['shipping']))).toEqual(refused("Coupon shipping discounts shipping, which the till can't apply"));
  });

  it('refuses a promotion that mixes shipping with an item discount', async () => {
    await promotion('SHIPMIX', { actions: [...percentage(), { code: 'free_shipping', arguments: [] }] });
    expect(await price(sale(['shipmix']))).toEqual(refused("Coupon shipmix discounts shipping, which the till can't apply"));
  });

  it('refuses a promotion that combines item and order discounts', async () => {
    await promotion('MIXED', { actions: [...percentage(), { code: 'order_fixed_discount', arguments: [{ name: 'discount', value: '100' }] }] });
    expect(await price(sale(['mixed']))).toEqual(refused("Coupon mixed combines item and order discounts, which the till can't apply"));
  });

  it('refuses promotions with side-effect hooks', async () => {
    await promotion('SIDE_EFFECT', { actions: [{ code: 'test_side_effect', arguments: [] }] });
    expect(await price(sale(['side_effect']))).toEqual(refused("Coupon side_effect adds items to the order, which the till can't apply"));
  });

  it('refuses ambiguous codes that Vendure allows to be created', async () => {
    const upper = await promotion('DUP5', { actions: percentage([variantIds.mug[0]], '5') });
    const lower = await promotion('dup5', { actions: percentage([variantIds.mug[0]], '5') });
    expect(upper).not.toBe(lower);
    expect(await price(sale(['dup5']))).toEqual(refused('Coupon dup5 matches more than one promotion; the store must fix it'));
  });

  it('refuses when the net coupon and till discounts exceed a discounted line price', async () => {
    const input = sale();
    input.lines = [{ ...input.lines[0], quantity: 1, unitPriceMinor: 100, discountMinor: 95 }];
    expect(await price(input)).toEqual(refused("Coupon cpn10 and the line's discount together exceed its price"));
  });

  it('ignores the till discount on a line that no coupon discounts', async () => {
    const input = sale();
    input.lines[1].discountMinor = 1001;
    expect(await price(input)).toEqual(priced('cpn10', cpn10, 'CPN10'));
  });

  it('refuses an unknown variant whose id decodes', async () => {
    const input = sale();
    const unknown = encode(999999);
    expect(decode(unknown)).toBe('999999');
    input.lines[0].variantId = unknown;
    expect(await price(input)).toEqual(refused('This sale has a product the store no longer sells'));
  });

  async function consume(promotionId: string, customerId?: string) {
    const result = await run(orderCommand(
      [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 2000 }],
      undefined, customerId ? { customerId } : undefined,
    ));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
    const order = await connection.getRepository(ctx, Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['promotions', 'lines', 'lines.productVariant', 'lines.taxCategory', 'shippingLines', 'shippingLines.shippingMethod', 'surcharges', 'customer'],
    });
    if (customerId) expect(String(order.customerId)).toBe(decode(customerId));
    // Test setup only: the later order.create job saves the order's coupon promotions for real.
    order.promotions = [await connection.getRepository(ctx, Promotion).findOneByOrFail({ id: decode(promotionId) })];
    await connection.getRepository(ctx, Order).save(order);
  }

  it('takes no use when pricing twice, then refuses an exhausted global usage limit', async () => {
    const id = await promotion('ONCE', { usageLimit: 1 });
    expect(await price(sale(['once']))).toEqual(priced('once', id, 'ONCE'));
    expect(await price(sale(['once']))).toEqual(priced('once', id, 'ONCE'));
    await consume(id);
    expect(await price(sale(['once']))).toEqual(refused('Coupon once has been used up'));
  });

  it('refuses a used per-customer limit only for that customer', async () => {
    const customers: string[] = [];
    for (const name of ['A', 'B']) {
      const { createCustomer } = await adminClient.query(parse(`mutation Customer($input: CreateCustomerInput!) {
        createCustomer(input: $input) { ... on Customer { id } ... on ErrorResult { message } }
      }`), { input: { firstName: 'Coupon', lastName: name, emailAddress: `${randomUUID()}@example.com` } });
      expect(createCustomer).toEqual({ id: expect.any(String) });
      customers.push(createCustomer.id);
    }
    const id = await promotion('MINE', { perCustomerUsageLimit: 1 });
    await consume(id, customers[0]);
    expect(await price({ ...sale(['mine']), customer: { customerId: customers[0] } }))
      .toEqual(refused('This customer has already used coupon mine'));
    expect(await price({ ...sale(['mine']), customer: { customerId: customers[1] } })).toEqual(priced('mine', id, 'MINE'));
    expect(await price(sale(['mine']))).toEqual(priced('mine', id, 'MINE'));
  });

  it('treats unknown and malformed customers as guests without a warning', async () => {
    for (const customerId of [encode(999999), 'not-an-id']) {
      expect(await price({ ...sale(), customer: { customerId } })).toEqual(priced('cpn10', cpn10, 'CPN10'));
    }
  });

  it('writes no orders, lines, or surcharges while pricing', async () => {
    const counts = async () => ({
      orders: await connection.getRepository(ctx, Order).count(),
      lines: await connection.getRepository(ctx, OrderLine).count(),
      surcharges: await connection.getRepository(ctx, Surcharge).count(),
    });
    const before = await counts();
    expect(await price(sale())).toEqual(priced('cpn10', cpn10, 'CPN10'));
    expect(await counts()).toEqual(before);
  });

  it('rejects unknown top-level fields', async () => {
    expect(await price({ ...sale(), extra: true })).toEqual({ status: 400, body: { code: 'invalid_payload', message: 'extra: unknown field' } });
  });

  it('rejects unknown line fields', async () => {
    const input = sale();
    expect(await price({ ...input, lines: [{ ...input.lines[0], extra: true }] }))
      .toEqual({ status: 400, body: { code: 'invalid_payload', message: 'lines[0].extra: unknown field' } });
  });

  it('rejects a line total beyond safe integers', async () => {
    const input = sale();
    input.lines[0] = { ...input.lines[0], quantity: 2 ** 30, unitPriceMinor: 2 ** 30 };
    expect(await price(input))
      .toEqual({ status: 400, body: { code: 'invalid_payload', message: 'lines[0].unitPriceMinor: line total is too large' } });
  });

  it('rejects an unknown tax class on a taxable custom line', async () => {
    const input = sale();
    input.lines[0] = { clientLineId: 'l1', custom: { name: 'Custom item', taxStatus: 'taxable', taxClass: 'no-such-class' }, quantity: 1, unitPriceMinor: 1000 };
    expect(await price(input))
      .toEqual({ status: 400, body: { code: 'invalid_payload', message: 'lines[0].custom.taxClass: unknown tax class' } });
  });

  it('rejects eleven codes', async () => {
    expect(await price(sale(Array.from({ length: 11 }, (_, i) => `code${i}`))))
      .toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
  });

  it('rejects duplicate codes, including different case', async () => {
    for (const codes of [['cpn10', 'cpn10'], ['CPN10', 'cpn10']]) {
      expect(await price(sale(codes))).toEqual({ status: 400, body: { code: 'invalid_payload', message: 'codes[1]: duplicate code' } });
    }
  });

  it('answers 400 when two codes resolve to the same promotion', async () => {
    const service = server.app.get(PromotionService);
    const validate = service.validateCouponCode.bind(service);
    const spy = vi.spyOn(service, 'validateCouponCode').mockImplementation((context, _code, ...args) => validate(context, 'CPN10', ...args));
    try {
      expect(await price(sale(['cpn10', 'zzz'])))
        .toEqual({ status: 400, body: { code: 'invalid_payload', message: 'codes[1]: duplicate code' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects an empty code list', async () => {
    expect(await price(sale([]))).toMatchObject({ status: 400, body: { code: 'invalid_payload' } });
  });

  it('rejects a currency other than the channel currency', async () => {
    expect(await price({ ...sale(), currency: 'USD' })).toEqual({ status: 400, body: { code: 'invalid_payload', message: 'currency: expected EUR' } });
  });

  it('rejects a line with both variantId and custom', async () => {
    const input = sale();
    input.lines[0].custom = { name: 'Custom item', taxStatus: 'none' };
    expect(await price(input)).toEqual({ status: 400, body: { code: 'invalid_payload', message: 'lines[0]: expected exactly one of variantId and custom' } });
  });

  it('allows the POS till role without ReadPromotion', async () => {
    expect(await price(sale(), await tokenWith(POS_TILL_PERMISSIONS))).toEqual(priced('cpn10', cpn10, 'CPN10'));
  });

  it('refuses a role with only ReadCatalog', async () => {
    expect((await price(sale(), await tokenWith(['ReadCatalog']))).status).toBe(403);
  });

  it('leaves /info without a coupons capability', async () => {
    const answer = await call('info', undefined, 'GET');
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain('"coupons":true');
  });
});
