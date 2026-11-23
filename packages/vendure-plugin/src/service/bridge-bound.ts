import type { Order } from '@vendure/core';

/** The smallest bound, in minor units, whatever the line count. */
export const BRIDGE_FLOOR_MINOR = 2;

/**
 * Money P3 #7 (Front desk ruling, 2026-11-23): the largest rounding bridge order.create accepts, in minor units:
 * max(2, one per order line). "Order line" is the count the v3 per-rate tolerance uses: product lines (custom items
 * included), surcharges (POS discounts and fees) and shipping lines, counted before the bridge's own surcharge exists.
 * Cash rounding is not part of the bridge (cashRoundings), so it never counts against this bound.
 */
export function bridgeBoundMinor(order: Pick<Order, 'lines' | 'surcharges' | 'shippingLines'>): number {
  return Math.max(BRIDGE_FLOOR_MINOR, order.lines.length + order.surcharges.length + order.shippingLines.length);
}
