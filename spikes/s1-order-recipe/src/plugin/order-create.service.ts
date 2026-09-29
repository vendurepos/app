import { Injectable } from '@nestjs/common';
import {
  CustomerService, Order, OrderCalculator, OrderLine, OrderService, PaymentService,
  RequestContext, ShippingLine, ShippingMethod, TransactionalConnection, manualFulfillmentHandler,
} from '@vendure/core';
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '../vendored/commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { TallyCommand } from './tally-command.entity';
import { unwrap } from './unwrap';

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
  constructor(
    private connection: TransactionalConnection,
    private customers: CustomerService,
    private orders: OrderService,
    private calculator: OrderCalculator,
    private payments: PaymentService,
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
    for (const line of payload.lines) {
      order = unwrap(await this.orders.addItemToOrder(ctx, order.id, line.variantId, line.quantity, {
        tallyUnitPrice: line.unitPriceMinor,
        tallyClientLineId: line.clientLineId,
        tallyPriceIncludesTax: line.taxInclusive ?? payload.pricesIncludeTax,
      }));
    }
    const shipping = await this.connection.getRepository(ctx, ShippingMethod).findOneOrFail({
      where: { code: 'tally-in-store', channels: { id: ctx.channelId } },
    });
    order = unwrap(await this.orders.setShippingMethod(ctx, order.id, [shipping.id]));
    order = await this.calculator.applyPriceAdjustments(ctx, order, []);
    await this.connection.getRepository(ctx, Order).save(order);
    await this.connection.getRepository(ctx, OrderLine).save(order.lines);
    await this.connection.getRepository(ctx, ShippingLine).save(order.shippingLines);
    order = unwrap(await this.orders.transitionToState(ctx, order.id, 'ArrangingPayment'));

    let remaining = payload.totalMinor;
    for (const tender of payload.payments) {
      if (remaining === 0) break;
      const amount = Math.min(tender.amountMinor, remaining);
      unwrap(await this.payments.createPayment(ctx, order, amount, 'tally-pos', { tender }));
      remaining -= amount;
    }
    order = (await this.orders.findOne(ctx, order.id))!;
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
    const result: CommandResult = {
      id: command.id, status: 'applied',
      serverRefs: { orderId: String(order.id), displayId: order.code, totalMinor: order.totalWithTax },
    };
    await this.connection.getRepository(ctx, TallyCommand).save({
      id: command.id, clientOrderId: payload.clientOrderId, fingerprint: commandFingerprint(command),
      status: 'applied', result: { ...result },
    });
    return result;
  }
}
