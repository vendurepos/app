import { PermissionDefinition } from '@vendure/core';
/** Sell at a VendurePOS till: the plugin's command and info routes. Narrower than CreateOrder, which they also accept so existing tills keep working. */
export const tallyPosSell = new PermissionDefinition({ name: 'TallyPosSell', description: 'Sell at a VendurePOS till (the plugin\'s /tally/v1 routes)' });
