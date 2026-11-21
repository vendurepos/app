import { Injectable } from '@nestjs/common';
import {
  ConfigService, Customer, CustomerService, Logger, Order, OrderCalculator, OrderLine, ProductVariant,
  Promotion, PromotionItemAction, PromotionLineAction, PromotionOrderAction, PromotionService, PromotionShippingAction,
  RequestContext, Surcharge, TaxCategory, TransactionalConnection,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { TALLY_CUSTOM_ITEM_SKU, TALLY_DISCOUNT_SKU, TALLY_NO_TAX_CATEGORY } from './constants';
import { loggerCtx } from './errors';
import { OrderCreateService } from './order-create.service';
import { resolveTaxCategory } from './tax-class';
import { MAX_INT4, MAX_STRING } from './value-ranges';

// A request bound; the till never sends that many codes.
export const MAX_COUPON_CODES = 10;

export type CouponPricingInput = {
  currency: string;
  pricesIncludeTax: boolean;
  customer?: { customerId: string };
  codes: string[];
  // Shipping and fees are absent: the till never discounts them. order.create saves fees as surcharges, which Vendure
  // counts in subTotal, so a minimum or order-percentage coupon can come out larger on the saved order (desk ruling: not modelled).
  lines: Array<{
    clientLineId: string;
    variantId?: string;
    custom?: { name: string; sku?: string; taxStatus: 'taxable' | 'none'; taxClass?: string };
    quantity: number;
    unitPriceMinor: number;
    taxInclusive?: boolean;
    discountMinor?: number;
  }>;
};
type Answer = { status: number; body: Record<string, unknown> };
const refusal = (status: number, code: string, message: string): Answer => ({ status, body: { code, message } });
const refusalTexts = {
  invalid: (code: string) => `Coupon ${code} isn't valid`,
  'used-up': (code: string) => `Coupon ${code} has been used up`,
  'customer-used': (code: string) => `This customer has already used coupon ${code}`,
  ambiguous: (code: string) => `Coupon ${code} matches more than one promotion; the store must fix it`,
  shipping: (code: string) => `Coupon ${code} discounts shipping, which the till can't apply`,
  mixed: (code: string) => `Coupon ${code} combines item and order discounts, which the till can't apply`,
  'side-effects': (code: string) => `Coupon ${code} adds items to the order, which the till can't apply`,
  "doesn't-apply": (code: string) => `Coupon ${code} doesn't apply to this sale`,
  exceed: (code: string) => `Coupon ${code} and the line's discount together exceed its price`,
  'no-longer-sold': () => 'This sale has a product the store no longer sells',
};

// Postgres order for productVariantId: numeric for integer ids, plain string comparison otherwise.
// It also orders promotion ids, for equal priorityScore.
function compareVariantIds(a: string | number, b: string | number): number {
  const integer = (id: string | number) => typeof id === 'number' || /^\d+$/.test(id);
  if (integer(a) && integer(b)) return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function objectError(value: unknown, path: string, fields: string[]): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: expected an object`;
  const extra = Object.keys(value).find(key => !fields.includes(key));
  return extra === undefined ? undefined : `${path === 'body' ? '' : `${path}.`}${extra}: unknown field`;
}

function shapeError(body: unknown): string | undefined {
  const top = objectError(body, 'body', ['currency', 'pricesIncludeTax', 'customer', 'codes', 'lines']);
  if (top) return top;
  const input = body as CouponPricingInput;
  if (typeof input.currency !== 'string') return 'currency: expected a string';
  if (typeof input.pricesIncludeTax !== 'boolean') return 'pricesIncludeTax: expected a boolean';
  if (input.customer !== undefined) {
    const error = objectError(input.customer, 'customer', ['customerId']);
    if (error) return error;
    if (typeof input.customer.customerId !== 'string') return 'customer.customerId: expected a string';
  }
  if (!Array.isArray(input.codes) || input.codes.length < 1 || input.codes.length > MAX_COUPON_CODES) {
    return `codes: expected 1 to ${MAX_COUPON_CODES} codes`;
  }
  const codes = new Set<string>();
  for (const [index, code] of input.codes.entries()) {
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_STRING) {
      return `codes[${index}]: expected a non-empty string of at most ${MAX_STRING} characters`;
    }
    if (codes.has(code.toLowerCase())) return `codes[${index}]: duplicate code`;
    codes.add(code.toLowerCase());
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) return 'lines: expected 1 to 100 lines';
  const lineIds = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    const path = `lines[${index}]`;
    const error = objectError(line, path, ['clientLineId', 'variantId', 'custom', 'quantity', 'unitPriceMinor', 'taxInclusive', 'discountMinor']);
    if (error) return error;
    if (typeof line.clientLineId !== 'string' || line.clientLineId.length === 0 || line.clientLineId.length > MAX_STRING) {
      return `${path}.clientLineId: expected a non-empty string of at most ${MAX_STRING} characters`;
    }
    if (lineIds.has(line.clientLineId)) return `${path}.clientLineId: duplicate line id`;
    lineIds.add(line.clientLineId);
    if ((line.variantId !== undefined) === (line.custom !== undefined)) return `${path}: expected exactly one of variantId and custom`;
    if (line.variantId !== undefined && typeof line.variantId !== 'string') return `${path}.variantId: expected a string`;
    if (line.custom !== undefined) {
      const customError = objectError(line.custom, `${path}.custom`, ['name', 'sku', 'taxStatus', 'taxClass']);
      if (customError) return customError;
      if (typeof line.custom.name !== 'string') return `${path}.custom.name: expected a string`;
      for (const field of ['sku', 'taxClass'] as const) {
        if (line.custom[field] !== undefined && typeof line.custom[field] !== 'string') return `${path}.custom.${field}: expected a string`;
      }
      if (line.custom.taxStatus !== 'taxable' && line.custom.taxStatus !== 'none') return `${path}.custom.taxStatus: expected taxable or none`;
    }
    for (const field of ['quantity', 'unitPriceMinor', 'discountMinor'] as const) {
      const value = line[field], minimum = field === 'quantity' ? 1 : 0;
      if (field === 'discountMinor' && value === undefined) continue;
      if (!Number.isSafeInteger(value) || value! < minimum || value! > MAX_INT4) {
        return `${path}.${field}: expected a whole number from ${minimum} to ${MAX_INT4}`;
      }
    }
    if (!Number.isSafeInteger(line.quantity * line.unitPriceMinor)) return `${path}.unitPriceMinor: line total is too large`;
    if (line.taxInclusive !== undefined && typeof line.taxInclusive !== 'boolean') return `${path}.taxInclusive: expected a boolean`;
  }
}

@Injectable()
export class CouponPricingService {
  constructor(
    private connection: TransactionalConnection, private recipe: OrderCreateService,
    private customers: CustomerService, private promotionService: PromotionService,
    private config: ConfigService, private calculator: OrderCalculator,
  ) {}

  private refuse(ctx: RequestContext, code: string, kind: keyof typeof refusalTexts, errorCode: string = kind) {
    Logger.info(`Coupon ${code}: ${errorCode}; activeUserId=${ctx.activeUserId}`, loggerCtx);
    return { refusal: refusalTexts[kind](code) };
  }

  async resolveCodes(ctx: RequestContext, codes: string[], customer: Customer | undefined): Promise<{ promotions: Promotion[] } | { refusal: string } | Answer> {
    const promotions: Promotion[] = [];
    for (const [index, code] of codes.entries()) {
      const matches = await this.connection.getRepository(ctx, Promotion).createQueryBuilder('promotion')
        .select('promotion.id').innerJoin('promotion.channels', 'channel')
        .where('channel.id = :channelId', { channelId: ctx.channelId })
        .andWhere('promotion.enabled = :enabled', { enabled: true }).andWhere('promotion.deletedAt IS NULL')
        .andWhere('LOWER(promotion.couponCode) = LOWER(:code)', { code }).getMany();
      if (matches.length > 1) {
        Logger.warn(`Coupon ${code} matches promotion ids ${matches.map(promotion => promotion.id).join(', ')}`, loggerCtx);
        return this.refuse(ctx, code, 'ambiguous');
      }
      const promotion = await this.promotionService.validateCouponCode(ctx, code, customer?.id);
      if (!(promotion instanceof Promotion)) {
        if (promotion.errorCode === 'COUPON_CODE_LIMIT_ERROR') {
          const withoutCustomer = await this.promotionService.validateCouponCode(ctx, code);
          return this.refuse(ctx, code, withoutCustomer instanceof Promotion ? 'customer-used' : 'used-up', promotion.errorCode);
        }
        return this.refuse(ctx, code, 'invalid', promotion.errorCode);
      }
      // Database LOWER can fold codes that JS toLowerCase keeps apart; one promotion is priced once.
      if (promotions.some(resolved => resolved.id === promotion.id)) {
        return refusal(400, 'invalid_payload', `codes[${index}]: duplicate code`);
      }
      if (promotion.startsAt && promotion.startsAt.getTime() > Date.now()) return this.refuse(ctx, code, 'invalid');
      const actions = promotion.actions.map(action => this.config.promotionOptions.promotionActions.find(definition => definition.code === action.code));
      if (actions.some(action => action instanceof PromotionShippingAction)) return this.refuse(ctx, code, 'shipping');
      if (actions.some(action => action instanceof PromotionItemAction || action instanceof PromotionLineAction)
        && actions.some(action => action instanceof PromotionOrderAction)) {
        return this.refuse(ctx, code, 'mixed');
      }
      // Vendure keeps the side-effect hooks in non-public fields; bracket access lets us refuse them before pricing.
      if (actions.some(action => action?.['onActivateFn'] || action?.['onDeactivateFn'])) return this.refuse(ctx, code, 'side-effects');
      promotions.push(promotion);
    }
    return { promotions };
  }

  async pricePromotions(ctx: RequestContext, input: CouponPricingInput, customer: Customer | undefined, promotions: Promotion[]): Promise<Answer> {
    const order = new Order({
      state: 'AddingItems', active: true, currencyCode: ctx.currencyCode, channels: [ctx.channel],
      lines: [], shippingLines: [], surcharges: [], promotions: [], shippingAddress: {}, billingAddress: {},
      couponCodes: promotions.map(promotion => promotion.couponCode!),
      ...(customer ? { customer, customerId: customer.id } : {}),
    });
    for (const [index, line] of input.lines.entries()) {
      let variant: ProductVariant, taxCategory: TaxCategory | null;
      if (line.custom) {
        const customVariant = await this.connection.getRepository(ctx, ProductVariant).findOne({
          where: { sku: TALLY_CUSTOM_ITEM_SKU, deletedAt: IsNull(), channels: { id: ctx.channelId } },
        });
        if (!customVariant) return refusal(503, 'store_setup', 'The store needs its POS setup repaired');
        variant = customVariant;
        taxCategory = line.custom.taxStatus === 'none'
          ? await this.connection.getRepository(ctx, TaxCategory).findOneByOrFail({ name: TALLY_NO_TAX_CATEGORY })
          : await resolveTaxCategory(ctx, this.connection, line.custom.taxClass);
        if (!taxCategory) return refusal(400, 'invalid_payload', `lines[${index}].custom.taxClass: unknown tax class`);
      } else {
        const found = await this.recipe.findVariant(ctx, line.variantId!);
        if (!found) return { status: 200, body: this.refuse(ctx, input.codes[0], 'no-longer-sold') };
        variant = found;
        taxCategory = (await this.connection.getRepository(ctx, ProductVariant).findOneOrFail({
          where: { id: variant.id }, relations: ['taxCategory'],
        })).taxCategory;
      }
      order.lines.push(new OrderLine({
        // Unsaved lines need distinct ids: buy_x_get_y_free keys its free quantity by line id.
        id: index + 1,
        order, productVariant: variant, productVariantId: variant.id, quantity: line.quantity,
        // A saved line gets orderPlacedQuantity 0 from its column default; unset, OrderLine.discounts divides by NaN.
        orderPlacedQuantity: 0,
        listPrice: line.unitPriceMinor, initialListPrice: line.unitPriceMinor,
        listPriceIncludesTax: line.taxInclusive ?? input.pricesIncludeTax,
        taxCategory, taxCategoryId: taxCategory.id, adjustments: [], taxLines: [],
      }));
    }
    // order.create adds its lines in one transaction, so they share createdAt and Vendure's final pass loads them by productVariantId (order.service.js:218-219); applyOrderItemPromotions re-tests conditions line by line in that order.
    order.lines.sort((a, b) => compareVariantIds(a.productVariantId, b.productVariantId));
    const byBody = input.lines.map((_, index) => order.lines.find(line => line.id === index + 1)!);
    // order.create saves each line's discountMinor as a net TALLY-DISCOUNT surcharge, and Vendure counts surcharges in subTotal; the first pass sets the lines' taxLines for them.
    await this.calculator.applyPriceAdjustments(ctx, order, []);
    for (const [index, line] of input.lines.entries()) {
      if (!(line.discountMinor! > 0)) continue;
      order.surcharges.push(new Surcharge({
        order, description: 'POS discount', sku: TALLY_DISCOUNT_SKU, listPrice: -line.discountMinor!,
        listPriceIncludesTax: false,
        taxLines: byBody[index].taxLines.map(({ taxRate, description }) => ({ taxRate, description })),
      }));
    }
    // Vendure applies promotions in priorityScore order (getActivePromotionsInChannel), whatever order the codes came in. Equal scores go by promotion id, so the answer never depends on the order sent; CPN-2's final pass must apply this same order.
    await this.calculator.applyPriceAdjustments(ctx, order, [...promotions].sort((a, b) => a.priorityScore - b.priorityScore || compareVariantIds(a.id, b.id)));
    const amounts = promotions.map(promotion => byBody.map(line => {
      const discounts = line.discounts.filter(discount => discount.adjustmentSource === promotion.getSourceId());
      const amount = discounts.reduce((sum, discount) => sum - (line.listPriceIncludesTax ? discount.amountWithTax : discount.amount), 0);
      if (!Number.isSafeInteger(amount)) throw new Error(`Invalid coupon amount for promotion ${promotion.id}`);
      return { amount, net: discounts.reduce((sum, discount) => sum - discount.amount, 0) };
    }));
    // With the till's discounts taking subTotal below zero, Vendure's order actions return a positive adjustment (order-fixed-discount-action.js); the till never applies one.
    for (const [index, code] of input.codes.entries()) {
      if (amounts[index].every(line => line.amount === 0) || amounts[index].some(line => line.amount < 0)) return { status: 200, body: this.refuse(ctx, code, "doesn't-apply") };
    }
    for (const [index, line] of byBody.entries()) {
      if (amounts.every(code => code[index].amount === 0)) continue;
      const net = amounts.reduce((sum, code) => sum + code[index].net, 0);
      if (net + (input.lines[index].discountMinor ?? 0) > line.linePrice) {
        const last = input.codes.filter((_, codeIndex) => amounts[codeIndex][index].amount > 0).at(-1)!;
        return { status: 200, body: this.refuse(ctx, last, 'exceed') };
      }
    }
    return { status: 200, body: { priced: Object.fromEntries(input.codes.map((code, index) => [code, {
      couponId: this.recipe.encodeId(promotions[index].id), code: promotions[index].couponCode,
      lines: amounts[index].flatMap((line, lineIndex) => line.amount > 0 ? [{ lineId: input.lines[lineIndex].clientLineId, amountMinor: line.amount }] : []),
    }])) } };
  }

  async price(ctx: RequestContext, body: unknown): Promise<Answer> {
    const error = shapeError(body);
    if (error) return refusal(400, 'invalid_payload', error);
    const input = body as CouponPricingInput;
    if (input.currency !== ctx.currencyCode) return refusal(400, 'invalid_payload', `currency: expected ${ctx.currencyCode}`);
    const customerId = input.customer ? this.recipe.decodeId(input.customer.customerId) : undefined;
    const customer = customerId === undefined ? undefined : await this.customers.findOne(ctx, customerId);
    const resolved = await this.resolveCodes(ctx, input.codes, customer);
    if ('status' in resolved) return resolved;
    if ('refusal' in resolved) return { status: 200, body: resolved };
    return this.pricePromotions(ctx, input, customer, resolved.promotions);
  }
}
