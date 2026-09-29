import { Injectable } from '@nestjs/common';
import {
  CustomerService, ID, Order, OrderCalculator, OrderLine, OrderService, PaymentService, ProductVariant,
  ProductVariantService, RequestContext, ShippingLine, ShippingMethod, StockLevelService, StockLocationService,
  StockMovementService, Surcharge, TransactionalConnection, manualFulfillmentHandler,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import type { CommandEnvelope, CommandResult, CommandWarning, OrderCreatePayload } from '../vendored/commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { ratePpmFromPercent } from '../vendored/tax-exact';
import { roundHalfAwayFromZero } from './rounding';
import { TallyCommand } from './tally-command.entity';
import { BusinessRejection, unwrap } from './unwrap';

export type TotalWarning =
  | { code: 'total_mismatch'; expectedMinor: number; serverMinor: number; bridgeMinor: number }
  | { code: 'tax_rate_mismatch'; ratePpm: number; expectedMinor: number; serverMinor: number };

type PricingStage = 'addItemToOrder' | 'setShippingMethod' | 'surchargeSave' | 'finalPass' | 'payments';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
  interface CustomOrderFields {
    tallyClientOrderId?: string | null;
    tallySaleAt?: Date | null;
    tallyRegisterId?: string | null;
    tallySessionId?: string | null;
    tallyCashierRef?: string | null;
    tallyPayments?: string | null;
    tallySnapshot?: string | null;
  }
  interface CustomOrderLineFields {
    tallyUnitPrice?: number | null;
    tallyClientLineId?: string | null;
    tallyPriceIncludesTax?: boolean | null;
  }
}

@Injectable()
export class OrderCreateService {
  // TEMPORARY spike observation only; tests reload through this transaction's repository.
  testObserver?: (stage: PricingStage, ctx: RequestContext, order: Order) => Promise<void>;

  constructor(
    private connection: TransactionalConnection,
    private customers: CustomerService,
    private orders: OrderService,
    private calculator: OrderCalculator,
    private payments: PaymentService,
    private variants: ProductVariantService,
    private stockLocations: StockLocationService,
    private stockLevels: StockLevelService,
    private stockMovements: StockMovementService,
  ) {}

  async create(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<CommandResult> {
    const payload = command.payload;
    let customer = payload.customer?.customerId
      ? await this.customers.findOne(ctx, payload.customer.customerId)
      : undefined;
    if (!customer) {
      const emailAddress = payload.customer?.email || 'walk-in@vendurepos.invalid';
      const existing = await this.customers.findAll(ctx, { filter: { emailAddress: { eq: emailAddress } } });
      customer = unwrap(await this.customers.createOrUpdate(ctx, {
        emailAddress,
        firstName: existing.items[0]?.firstName ?? '', lastName: existing.items[0]?.lastName ?? '',
      }));
    }
    let order = await this.orders.createDraft(ctx);
    order.customer = customer;
    order.customFields = {
      ...order.customFields,
      tallyClientOrderId: payload.clientOrderId,
      tallySaleAt: new Date(payload.createdAt),
      tallyRegisterId: payload.registerId,
      tallySessionId: command.version === 3 ? payload.sessionId : undefined,
      tallyCashierRef: payload.cashierRef,
    };
    await this.connection.getRepository(ctx, Order).save(order);
    const requested = new Map<string, { variant: ProductVariant; quantity: number }>();
    for (const line of payload.lines) {
      const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
        where: { id: line.variantId, deletedAt: IsNull(), channels: { id: ctx.channelId } },
      });
      if (!variant || !variant.enabled) {
        throw new BusinessRejection('unknown_variant', `Variant ${line.variantId} is missing or disabled`);
      }
      const entry = requested.get(line.variantId) ?? { variant, quantity: 0 };
      requested.set(line.variantId, { variant, quantity: entry.quantity + line.quantity });
    }
    // ADR 0002 "Stock": top up a shortage before addItemToOrder, whose constrainQuantityToSaleable
    // would cut the quantity, and before ArrangingPayment, which checks saleable stock again.
    const location = await this.stockLocations.defaultStockLocation(ctx);
    const topUps: Array<{ variantId: string; quantity: number }> = [];
    for (const [variantId, { variant, quantity }] of requested) {
      const shortfall = quantity - await this.variants.getSaleableStockLevel(ctx, variant);
      if (shortfall <= 0) continue;
      await this.adjustStock(ctx, variantId, location.id, shortfall);
      topUps.push({ variantId, quantity: shortfall });
    }
    for (const line of payload.lines) {
      order = unwrap(await this.orders.addItemToOrder(ctx, order.id, line.variantId, line.quantity, {
        tallyUnitPrice: line.unitPriceMinor,
        tallyClientLineId: line.clientLineId,
        tallyPriceIncludesTax: line.taxInclusive ?? payload.pricesIncludeTax,
      }));
      await this.testObserver?.('addItemToOrder', ctx, order);
    }
    const shipping = await this.connection.getRepository(ctx, ShippingMethod).findOneOrFail({
      where: { code: 'tally-in-store', channels: { id: ctx.channelId } },
    });
    order = unwrap(await this.orders.setShippingMethod(ctx, order.id, [shipping.id]));
    await this.testObserver?.('setShippingMethod', ctx, order);
    for (const line of payload.lines) {
      if (!(line.discountMinor! > 0)) continue;
      const orderLine = order.lines.find(item => item.customFields.tallyClientLineId === line.clientLineId)!;
      const surcharge = await this.connection.getRepository(ctx, Surcharge).save(new Surcharge({
        order, description: 'POS discount', sku: 'TALLY-DISCOUNT', listPrice: -line.discountMinor!,
        listPriceIncludesTax: line.taxInclusive ?? payload.pricesIncludeTax,
        taxLines: orderLine.taxLines.map(({ taxRate, description }) => ({ taxRate, description })),
      }));
      order.surcharges.push(surcharge);
      await this.testObserver?.('surchargeSave', ctx, order);
    }
    // calculateOrderTotals reads surcharge.price/priceWithTax; these getters compute tax
    // from taxLines. applyTaxes only visits product lines, so attach surcharges above.
    order = await this.calculator.applyPriceAdjustments(ctx, order, []);
    const totalWarnings: TotalWarning[] = [];
    const serverMinor = order.totalWithTax;
    const bridgeMinor = payload.totalMinor - serverMinor;
    if (bridgeMinor !== 0) {
      const bridge = await this.connection.getRepository(ctx, Surcharge).save(new Surcharge({
        order, description: 'POS rounding', sku: 'TALLY-ROUNDING', listPrice: bridgeMinor,
        listPriceIncludesTax: true, taxLines: [],
      }));
      order.surcharges.push(bridge);
      this.calculator.calculateOrderTotals(order);
      totalWarnings.push({ code: 'total_mismatch', expectedMinor: payload.totalMinor, serverMinor, bridgeMinor });
    }
    if (command.version === 3) {
      // For an integer count, half-away rounding of count/2 equals ceil(count/2).
      const T = Number(roundHalfAwayFromZero(BigInt(order.lines.length + order.surcharges.length), 2n));
      const pos = new Map<number, number>();
      const vendure = new Map<number, number>();
      for (const rate of payload.taxByRate!) {
        pos.set(rate.ratePpm, (pos.get(rate.ratePpm) ?? 0) + rate.taxMinor);
      }
      for (const rate of order.taxSummary) {
        const ratePpm = ratePpmFromPercent(rate.taxRate);
        vendure.set(ratePpm, (vendure.get(ratePpm) ?? 0) + rate.taxTotal);
      }
      const perRate = [...new Set([...pos.keys(), ...vendure.keys()])].map(ratePpm => ({
        ratePpm, pos: pos.get(ratePpm) ?? 0, vendure: vendure.get(ratePpm) ?? 0,
        diff: (vendure.get(ratePpm) ?? 0) - (pos.get(ratePpm) ?? 0),
      }));
      for (const rate of perRate) {
        if (Math.abs(rate.diff) > T) totalWarnings.push({
          code: 'tax_rate_mismatch', ratePpm: rate.ratePpm, expectedMinor: rate.pos, serverMinor: rate.vendure,
        });
      }
      console.log('S1-NUM', JSON.stringify({ proof: 1, stage: 'recipe', T, perRate, bridge: bridgeMinor }));
    }
    await this.connection.getRepository(ctx, Order).save(order);
    await this.connection.getRepository(ctx, OrderLine).save(order.lines);
    await this.connection.getRepository(ctx, ShippingLine).save(order.shippingLines);
    await this.testObserver?.('finalPass', ctx, order);
    order = unwrap(await this.orders.transitionToState(ctx, order.id, 'ArrangingPayment'));

    let remaining = payload.totalMinor;
    for (const tender of payload.payments) {
      if (remaining === 0) break;
      const amount = Math.min(tender.amountMinor, remaining);
      unwrap(await this.payments.createPayment(ctx, order, amount, 'tally-pos', { tender }));
      remaining -= amount;
    }
    order = (await this.orders.findOne(ctx, order.id))!;
    await this.testObserver?.('payments', ctx, order);
    if (order.state !== 'PaymentSettled') {
      order = unwrap(await this.orders.transitionToState(ctx, order.id, 'PaymentSettled'));
    }
    order.customFields.tallyPayments = JSON.stringify(payload.payments);
    order.orderPlacedAt = new Date(payload.createdAt);
    if (command.version === 3) {
      order.customFields.tallySnapshot = JSON.stringify({ display: payload.display, taxByRate: payload.taxByRate });
    }
    await this.connection.getRepository(ctx, Order).save(order);

    const fulfillment = unwrap(await this.orders.createFulfillment(ctx, {
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity })),
      handler: {
        code: manualFulfillmentHandler.code,
        arguments: [{ name: 'method', value: 'In-store collection' }, { name: 'trackingCode', value: '' }],
      },
    }));
    unwrap(await this.orders.transitionFulfillmentToState(ctx, fulfillment.id, 'Delivered'));
    for (const topUp of topUps) await this.adjustStock(ctx, topUp.variantId, location.id, -topUp.quantity);
    const warnings: CommandWarning[] = topUps.map(topUp => ({ code: 'insufficient_stock', ...topUp }));
    const result: CommandResult & { totalWarnings?: TotalWarning[] } = {
      id: command.id, status: 'applied',
      serverRefs: { orderId: String(order.id), displayId: order.code, totalMinor: order.totalWithTax },
      ...(warnings.length ? { warnings } : {}),
      ...(totalWarnings.length ? { totalWarnings } : {}),
    };
    await this.connection.getRepository(ctx, TallyCommand).save({
      id: command.id, clientOrderId: payload.clientOrderId, fingerprint: commandFingerprint(command),
      status: 'applied', result: { ...result },
    });
    return result;
  }

  private async adjustStock(ctx: RequestContext, variantId: string, stockLocationId: ID, change: number) {
    const level = await this.stockLevels.getStockLevel(ctx, variantId, stockLocationId);
    await this.stockMovements.adjustProductVariantStock(ctx, variantId, [
      { stockLocationId, stockOnHand: level.stockOnHand + change },
    ]);
  }
}
