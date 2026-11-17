import { useEffect, useState } from 'react';
import { moneyFromDecimalString, type SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';

/** Vendure permissions that let a role change a variant's price, stock and stock tracking (updateProductVariants). */
export const CATALOGUE_EDIT_PERMISSIONS = ['UpdateCatalog', 'UpdateProduct'];
export const PRICE_INVALID_TEXT = 'Enter a price such as 9.50.';
export const STOCK_INVALID_TEXT = 'Enter stock as a whole number, 0 or more.';
export const PRODUCT_SAVE_FORBIDDEN_TEXT = "This till's role can't change the store's products. Ask the store's admin to add the Update catalog permission.";
export const PRODUCT_SAVE_FAILED_TEXT = "Can't save this change to the store. Try again.";
/** One inline edit in the Products panel. */
export type ProductEdit = { field: 'price'; text: string } | { field: 'stock'; text: string; target: StockTarget } | { field: 'manage'; on: boolean };
/** Where a stock edit lands: the variant's one stock level, and what Vendure holds back from sale there (allocated units and the out-of-stock threshold). */
export type StockTarget = { stockLocationId: string; stockAllocated: number; threshold: number };
/** The stock fields of a Vendure Admin API variant that a stock edit needs. */
export type VendureVariantStock = { stockLevels?: { stockLocationId: string; stockAllocated: number }[]; useGlobalOutOfStockThreshold?: boolean; outOfStockThreshold?: number };
/** Vendure's UpdateProductVariantInput, with only the fields the panel writes. */
export type VariantUpdateInput = { id: string; price?: number; stockLevels?: { stockLocationId: string; stockOnHand: number }[]; trackInventory?: 'TRUE' | 'FALSE' };

/** The variant's one stock level and threshold (global unless the variant opts out), the same rule as the connector's `variantStock`; null when not exactly one level. */
export function stockTarget(variant: VendureVariantStock | undefined, globalThreshold: number): StockTarget | null {
  if (variant?.stockLevels?.length !== 1) return null;
  const [level] = variant.stockLevels;
  const threshold = variant.useGlobalOutOfStockThreshold !== false ? globalThreshold : variant.outOfStockThreshold ?? 0;
  return { stockLocationId: String(level.stockLocationId), stockAllocated: level.stockAllocated, threshold };
}
export function variantUpdateInput(variantId: string, edit: ProductEdit, currency: string): VariantUpdateInput | null {
  if (edit.field === 'manage') return { id: variantId, trackInventory: edit.on ? 'TRUE' : 'FALSE' };
  if (edit.field === 'price') {
    const money = moneyFromDecimalString(edit.text, currency);
    return money ? { id: variantId, price: money.amount } : null;
  }
  const text = edit.text.trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) return null;
  // The row shows saleable stock, so on hand is the typed figure plus what Vendure holds back (allocated and threshold), never top-level stockOnHand.
  const { stockLocationId, stockAllocated, threshold } = edit.target;
  return { id: variantId, stockLevels: [{ stockLocationId, stockOnHand: Number(text) + stockAllocated + threshold }] };
}
export function canEditCatalogue(permissions: readonly string[]): boolean { return CATALOGUE_EDIT_PERMISSIONS.some(p => permissions.includes(p)); }
export async function catalogueEditable(context: SyncContext): Promise<boolean> {
  try {
    const query = 'query CataloguePermissions { me { channels { id permissions } } activeChannel { id } }';
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ query }) });
    if (!response.ok) return false;
    const body = await response.json();
    if (body.errors?.length) return false;
    const channel = body.data?.me?.channels?.find((channel: { id: string; permissions: string[] }) => channel.id === body.data?.activeChannel?.id);
    return channel ? canEditCatalogue(channel.permissions) : false;
  } catch { return false; }
}
export function useCatalogueEditable(session: Session): boolean {
  const [editable, setEditable] = useState(false);
  useEffect(() => {
    setEditable(false);
    let cancelled = false;
    catalogueEditable(sessionContext(session)).then(result => { if (!cancelled) setEditable(result); });
    return () => { cancelled = true; };
  }, [session]);
  return editable;
}
export async function saveVariantUpdate(context: SyncContext, input: VariantUpdateInput): Promise<string | null> {
  try {
    const query = 'mutation UpdateProductVariants($input: [UpdateProductVariantInput!]!) { updateProductVariants(input: $input) { id } }';
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ query, variables: { input: [input] } }) });
    if (response.status === 401 || response.status === 403) return PRODUCT_SAVE_FORBIDDEN_TEXT;
    const body = await response.json();
    if (body.errors?.[0]?.extensions?.code === 'FORBIDDEN') return PRODUCT_SAVE_FORBIDDEN_TEXT;
    return response.ok && !body.errors?.length ? null : PRODUCT_SAVE_FAILED_TEXT;
  } catch { return PRODUCT_SAVE_FAILED_TEXT; }
}
