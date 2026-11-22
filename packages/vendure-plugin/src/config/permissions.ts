import { PermissionDefinition } from '@vendure/core';
/** Sell at a VendurePOS till: the plugin's command and info routes. Narrower than CreateOrder, which they also accept so existing tills keep working. */
export const tallyPosSell = new PermissionDefinition({ name: 'TallyPosSell', description: 'Sell at a VendurePOS till (the plugin\'s /tally/v1 routes)' });
/** Approve a register close over the variance threshold (medusapos ADR 0023, "What vendurepos can copy"). `POST /tally/v1/register-approvals` requires it of the manager whose credentials it checks (#332); it never opens the /tally/v1 routes. */
export const tallyPosApproveVariance = new PermissionDefinition({ name: 'ApproveTallyPosVariance', description: 'Approve a VendurePOS register close over the variance threshold' });
/** Refund a sale at a VendurePOS till (Front desk ruling, 2026-10-07: its own permission, not Vendure's broad UpdateOrder). RefundService requires it for order.refund (ADR 0007); it never opens the /tally/v1 routes, and the till role preset leaves it out. */
export const tallyPosRefund = new PermissionDefinition({ name: 'TallyPosRefund', description: 'Refund a sale at a VendurePOS till' });
/** Pair, list, signal and forget customer displays at a VendurePOS till (TallyUI ADR-085's `customer_display.pair`). The only permission the till-side `/tally/v1/displays` routes accept; TallyPosSell and CreateOrder do not open them. */
export const tallyPosPairDisplay = new PermissionDefinition({ name: 'TallyPosPairDisplay', description: 'Pair a customer display at a VendurePOS till' });
/** Lists a channel's customer-display devices and resets one, so a till whose device key was lost registers again (9.8e). */
export const tallyPosResetDisplayDevice = new PermissionDefinition({ name: 'TallyPosResetDisplayDevice', description: "Reset a VendurePOS till's customer-display device" });
