import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Payment, Refund, RequestContext, TransactionalConnection } from '@vendure/core';
import { OrderHistoryEntry } from '@vendure/core/dist/entity/history-entry/order-history-entry.entity';
import { SHOP_REFUND_REASON, SHOP_CANCEL_REASON } from '../service/constants';

export { SHOP_REFUND_REASON, SHOP_CANCEL_REASON } from '../service/constants';

type Scope = { posOrder: boolean; tillRefund: boolean };

// A POS order is any order the plugin wrote: its first write sets tallyClientOrderId, a rejection swaps that for
// tallyRejectedClientOrderId and tallyRejected, and tallySnapshot comes last. An order that cannot be loaded counts
// as POS, so the Shop API shows the neutral reason rather than staff text (fail closed).
export function isPosOrder(customFields: Record<string, unknown> | undefined | null): boolean {
  return customFields == null || customFields.tallySnapshot != null || customFields.tallyClientOrderId != null ||
    customFields.tallyRejectedClientOrderId != null || customFields.tallyRejected === true;
}

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
      posOrder = isPosOrder(payment?.order?.customFields as Parameters<typeof isPosOrder>[0]);
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
    if (!history) return shopHistoryData(entry.type, entry.data, { posOrder: true, tillRefund: false });
    const posOrder = isPosOrder(history.order?.customFields as Parameters<typeof isPosOrder>[0]);
    let tillRefund = false;
    if (!posOrder && entry.type === 'ORDER_REFUND_TRANSITION' && entry.data.refundId != null) {
      const refund = await this.connection.getRepository(ctx, Refund).findOneBy({ id: entry.data.refundId });
      tillRefund = refund?.metadata?.tallyClientRefundId != null;
    }
    return shopHistoryData(entry.type, entry.data, { posOrder, tillRefund });
  }
}
