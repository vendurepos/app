import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, OrderHistoryEntry, Payment, Refund, RequestContext, TransactionalConnection } from '@vendure/core';

// The fixed refund reason a shopper sees in place of staff text.
export const SHOP_REFUND_REASON = 'Refunded';
// The fixed cancellation reason a shopper sees in place of staff text.
export const SHOP_CANCEL_REASON = 'Cancelled';

type Scope = { posOrder: boolean; tillRefund: boolean };

export function shopRefundReason(reason: string | null | undefined, scope: Scope): string | null | undefined {
  return typeof reason === 'string' && reason !== '' && (scope.posOrder || scope.tillRefund) ? SHOP_REFUND_REASON : reason;
}

export function shopHistoryData(type: string, data: Record<string, unknown>, scope: Scope): Record<string, unknown> {
  if (!scope.posOrder && !scope.tillRefund) return data;
  if (type === 'ORDER_CUSTOMER_UPDATED' && 'note' in data) {
    const { note, ...rest } = data;
    return rest;
  }
  if (typeof data.reason === 'string' && data.reason !== '') {
    if (type === 'ORDER_REFUND_TRANSITION') return { ...data, reason: SHOP_REFUND_REASON };
    if (type === 'ORDER_CANCELLATION') return { ...data, reason: SHOP_CANCEL_REASON };
  }
  return data;
}

@Resolver('Refund')
export class TallyShopRefundResolver {
  constructor(private readonly connection: TransactionalConnection) {}

  @ResolveField()
  metadata(@Parent() refund: Refund) {
    // Keep till details private, as payment-entity.resolver.js does for Shop payment metadata.
    return { public: refund.metadata?.public };
  }

  @ResolveField()
  async reason(@Ctx() ctx: RequestContext, @Parent() refund: Refund) {
    const tillRefund = refund.metadata?.tallyClientRefundId != null;
    let posOrder = false;
    if (refund.reason && !tillRefund) {
      const payment = await this.connection.getRepository(ctx, Payment).findOne({ where: { id: refund.paymentId }, relations: ['order'] });
      posOrder = payment?.order.customFields.tallySnapshot != null;
    }
    return shopRefundReason(refund.reason, { posOrder, tillRefund });
  }
}

@Resolver('HistoryEntry')
export class TallyShopHistoryEntryResolver {
  constructor(private readonly connection: TransactionalConnection) {}

  @ResolveField()
  async data(@Ctx() ctx: RequestContext, @Parent() entry: OrderHistoryEntry) {
    if (shopHistoryData(entry.type, entry.data, { posOrder: true, tillRefund: false }) === entry.data) return entry.data;
    const history = await this.connection.getRepository(ctx, OrderHistoryEntry).findOne({ where: { id: entry.id }, relations: ['order'] });
    if (!history) return entry.data;
    const posOrder = history.order.customFields.tallySnapshot != null;
    let tillRefund = false;
    if (!posOrder && entry.type === 'ORDER_REFUND_TRANSITION' && entry.data.refundId != null) {
      const refund = await this.connection.getRepository(ctx, Refund).findOneBy({ id: entry.data.refundId });
      tillRefund = refund?.metadata?.tallyClientRefundId != null;
    }
    return shopHistoryData(entry.type, entry.data, { posOrder, tillRefund });
  }
}
