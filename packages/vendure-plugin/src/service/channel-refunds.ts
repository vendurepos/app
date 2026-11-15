import { Refund, type RequestContext, type TransactionalConnection } from '@vendure/core';

/** The channel's non-failed refunds, joined as `payment`, `sale` (the order) and `channel`; callers add their own filters. */
export function channelRefunds(connection: TransactionalConnection, ctx: RequestContext) {
  return connection.getRepository(ctx, Refund).createQueryBuilder('refund')
    .innerJoin('refund.payment', 'payment')
    .innerJoin('payment.order', 'sale')
    .innerJoin('sale.channels', 'channel')
    .where('channel.id = :channelId', { channelId: ctx.channelId })
    .andWhere('refund.state != :failed', { failed: 'Failed' });
}
