import { Permission } from '@vendure/core';
import { tallyPosPairDisplay, tallyPosSell } from './permissions';

export const POS_TILL_ROLE_CODE = 'vendurepos-pos-till';
/** What a till needs: sell through the plugin, pair a customer display (any cashier may, as in WCPOS v2), read the catalogue and the store settings, find, create and edit customers (never delete them), list the store's orders. */
export const POS_TILL_PERMISSIONS: string[] = [
  tallyPosSell.Permission, tallyPosPairDisplay.Permission, Permission.ReadCatalog, Permission.ReadSettings, Permission.ReadCustomer, Permission.CreateCustomer, Permission.UpdateCustomer, Permission.ReadOrder,
];
