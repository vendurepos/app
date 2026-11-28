import { idsAreEqual, Order } from '@vendure/core';
import { EntitySubscriberInterface, EventSubscriber, UpdateEvent } from 'typeorm';
import { isPosOrder } from '../api/shop-api';

// #555/#557: stored addresses belong to the earlier customer; any route changing a placed POS sale's customer clears them.
@EventSubscriber()
export class MovedOrderAddresses implements EntitySubscriberInterface<Order> {
  listenTo() { return Order; }

  beforeUpdate(event: UpdateEvent<Order>) {
    const order = event.entity as Order | undefined;
    const before = event.databaseEntity as Order | undefined;
    if (!order || !before || !('customer' in order) || order.customer === undefined) return;
    const newId = order.customer?.id ?? null;
    const oldId = before.customerId ?? null;
    if ((newId === null && oldId === null) || idsAreEqual(newId, oldId)) return;
    if (!(order.orderPlacedAt ?? before.orderPlacedAt) || !isPosOrder((order.customFields ?? before.customFields) as Parameters<typeof isPosOrder>[0])) return;
    if (Object.keys(order.billingAddress ?? {}).length || Object.keys(order.shippingAddress ?? {}).length) {
      // Not OrderService.unset*Address: those reprice the paid sale via applyPriceAdjustments.
      // The clear rides the caller's UPDATE, so it commits or rolls back with the move.
      order.billingAddress = {};
      order.shippingAddress = {};
    }
  }
}
