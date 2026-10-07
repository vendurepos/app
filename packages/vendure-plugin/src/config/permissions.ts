import { PermissionDefinition } from '@vendure/core';
/** Sell at a VendurePOS till: the plugin's command and info routes. Narrower than CreateOrder, which they also accept so existing tills keep working. */
export const tallyPosSell = new PermissionDefinition({ name: 'TallyPosSell', description: 'Sell at a VendurePOS till (the plugin\'s /tally/v1 routes)' });
/** Approve a register close over the variance threshold (medusapos ADR 0023, "What vendurepos can copy"). Nothing checks it until the approval route lands with register contract 3; it never opens the /tally/v1 routes. */
export const tallyPosApproveVariance = new PermissionDefinition({ name: 'ApproveTallyPosVariance', description: 'Approve a VendurePOS register close over the variance threshold' });
/** Refund a sale at a VendurePOS till (Front desk ruling, 2026-10-07: its own permission, not Vendure's broad UpdateOrder). RefundService requires it for order.refund (ADR 0007); it never opens the /tally/v1 routes, and the till role preset leaves it out. */
export const tallyPosRefund = new PermissionDefinition({ name: 'TallyPosRefund', description: 'Refund a sale at a VendurePOS till' });
