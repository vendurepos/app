// Mirrors @tallyui/components 3.0.2 src/sale/order-reference.ts, which its package index doesn't export yet: the
// reference a visitor sees on the receipt and in Orders (front desk ruling, 2026-10-06). Replace with TallyUI's export once it has one.
export function orderReference(order: { id: string; serverRefs?: { displayId?: string } }): string {
  const local = order.id.slice(-8);
  return order.serverRefs?.displayId ? `${local} · #${order.serverRefs.displayId}` : local;
}
