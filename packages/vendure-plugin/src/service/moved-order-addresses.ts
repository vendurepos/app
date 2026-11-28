import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { EventBus, HistoryEntryEvent, Order, TransactionalConnection } from '@vendure/core';
import { OrderHistoryEntry } from '@vendure/core/dist/entity/history-entry/order-history-entry.entity';
import { isPosOrder } from '../api/shop-api';

// #555: the 5.2a addresses belong to the earlier customer. No plugin command re-sends them after order.create.
@Injectable()
export class MovedOrderAddresses implements OnApplicationBootstrap {
  constructor(private readonly eventBus: EventBus, private readonly connection: TransactionalConnection) {}

  onApplicationBootstrap() {
    this.eventBus.registerBlockingEventHandler({
      event: HistoryEntryEvent,
      id: 'tally-pos-moved-order-addresses',
      handler: async event => {
        if (event.type !== 'created' || event.historyType !== 'order' || typeof event.input !== 'object' ||
          event.input?.type !== HistoryEntryType.ORDER_CUSTOMER_UPDATED) return;
        const id = (event.entity as OrderHistoryEntry).order.id;
        const order = await this.connection.getRepository(event.ctx, Order).findOne({ where: { id } });
        if (!order || !isPosOrder(order.customFields as Parameters<typeof isPosOrder>[0])) return;
        if (Object.keys(order.billingAddress).length || Object.keys(order.shippingAddress).length) {
          // Not OrderService.unset*Address: those reprice the order (applyPriceAdjustments), and this sale is paid.
          await this.connection.getRepository(event.ctx, Order).update({ id }, { billingAddress: {}, shippingAddress: {} });
        }
      },
    });
  }
}
