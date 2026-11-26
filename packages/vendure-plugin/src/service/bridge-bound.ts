import type { Order } from '@vendure/core';
import type { OrderCreatePayload } from '../vendored/commands';
import { roundHalfAwayFromZero } from './rounding';

/** The smallest bound, in minor units, whatever the line count. */
export const BRIDGE_FLOOR_MINOR = 2;

/**
 * Money P3 #7 (Front desk ruling, 2026-11-23): the largest rounding bridge order.create accepts, in minor units:
 * max(2, one per order line). Unlike per-rate T (rateToleranceMinor), this bound keeps the saved order's count: product lines (custom items
 * included), surcharges (POS discounts and fees) and shipping lines, counted before the bridge's own surcharge exists.
 * Cash rounding is not part of the bridge (cashRoundings), so it never counts against this bound.
 */
export function bridgeBoundMinor(order: Pick<Order, 'lines' | 'surcharges' | 'shippingLines'>): number {
  return Math.max(BRIDGE_FLOOR_MINOR, order.lines.length + order.surcharges.length + order.shippingLines.length);
}

/** Per-rate tolerance T uses TallyUI ADR-048's count, the same as @tallyui/pos needsAttention's rounding-bridge tolerance.
 * Only payload rows count: POS discounts, the bridge and Vendure's always-present shipping line do not widen T
 * (Front desk ruling, 2026-11-26).
 */
export function rateToleranceMinor(payload: Pick<OrderCreatePayload, 'lines' | 'fees' | 'shipping'>): number {
  const rows = payload.lines.length + (payload.fees?.length ?? 0) + (payload.shipping?.length ?? 0);
  return Number(roundHalfAwayFromZero(BigInt(rows), 2n));
}
