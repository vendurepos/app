import { Permission } from '@vendure/core';
import { tallyPosSell } from './permissions';

export const POS_TILL_ROLE_CODE = 'vendurepos-pos-till';
/** What a till needs: sell through the plugin, read the catalogue and the store settings, find and create customers, list the store's orders. */
export const POS_TILL_PERMISSIONS: string[] = [
  tallyPosSell.Permission, Permission.ReadCatalog, Permission.ReadSettings, Permission.ReadCustomer, Permission.CreateCustomer, Permission.ReadOrder,
];
