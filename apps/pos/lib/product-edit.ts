import { useEffect, useState } from 'react';
import { moneyFromDecimalString, type SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';

/** Vendure permissions that let a role change a variant's price, stock and stock tracking (updateProductVariants). */
export const CATALOGUE_EDIT_PERMISSIONS = ['UpdateCatalog', 'UpdateProduct'];
export const PRICE_INVALID_TEXT = 'Enter a price such as 9.50.';
export const STOCK_INVALID_TEXT = 'Enter stock as a whole number, 0 or more.';
export const PRODUCT_SAVE_FORBIDDEN_TEXT = "This till's role can't change the store's products. Ask the store's admin to add the Update catalog permission.";
export const PRODUCT_SAVE_FAILED_TEXT = "Can't save this change to the store. Try again.";
export const STOCK_CHANGED_TEXT = 'Stock changed in the store. Check the new figure and try again.';
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
/** What the panel may edit. Vendure stores `price` in the channel's default currency and tax mode, so a price edit is offered only when the till shows that same currency and mode. */
export type CatalogueAccess = { editable: boolean; priceEditable: boolean };
const NO_ACCESS: CatalogueAccess = { editable: false, priceEditable: false };
export async function catalogueEditable(context: SyncContext, till: { currency: string; pricesIncludeTax: boolean }): Promise<CatalogueAccess> {
  try {
    const query = 'query CataloguePermissions { me { channels { id permissions } } activeChannel { id defaultCurrencyCode pricesIncludeTax } }';
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ query }) });
    if (!response.ok) return NO_ACCESS;
    const body = await response.json();
    if (body.errors?.length) return NO_ACCESS;
    const active = body.data?.activeChannel;
    const channel = body.data?.me?.channels?.find((channel: { id: string; permissions: string[] }) => channel.id === active?.id);
    const editable = channel ? canEditCatalogue(channel.permissions) : false;
    return { editable, priceEditable: editable && active.defaultCurrencyCode === till.currency && active.pricesIncludeTax === till.pricesIncludeTax };
  } catch { return NO_ACCESS; }
}
export function useCatalogueEditable(session: Session, currency: string): CatalogueAccess {
  const [access, setAccess] = useState(NO_ACCESS);
  useEffect(() => {
    setAccess(NO_ACCESS);
    let cancelled = false;
    catalogueEditable(sessionContext(session), { currency, pricesIncludeTax: session.settings.pricesIncludeTax })
      .then(result => { if (!cancelled) setAccess(result); });
    return () => { cancelled = true; };
  }, [session, currency]);
  return access;
}
/** The variant's stock re-read from the store right before a stock write: its target and its saleable figure by the connector's `variantStock` rule (on hand less allocated less threshold, never below 0); null when the read fails or the variant has not exactly one level. */
export async function freshStock(context: SyncContext, variantId: string): Promise<{ target: StockTarget; saleable: number } | null> {
  try {
    const query = 'query VariantStockLevel($id: ID!) { productVariant(id: $id) { stockLevels { stockLocationId stockOnHand stockAllocated } useGlobalOutOfStockThreshold outOfStockThreshold } globalSettings { outOfStockThreshold } }';
    const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ query, variables: { id: variantId } }) });
    const body = response.ok ? await response.json() : null;
    const variant = body?.data?.productVariant, globalThreshold = body?.data?.globalSettings?.outOfStockThreshold, onHand = variant?.stockLevels?.[0]?.stockOnHand;
    const target = !body?.errors?.length && typeof globalThreshold === 'number' ? stockTarget(variant ?? undefined, globalThreshold) : null;
    return target && typeof onHand === 'number' ? { target, saleable: Math.max(onHand - target.stockAllocated - target.threshold, 0) } : null;
  } catch { return null; }
}
/** The write is absolute and another till may have sold since the sync: the stock input on the fresh target while the store's saleable figure is still the one shown, else why nothing is written. */
export async function checkStockEdit(context: SyncContext, variantId: string, edit: ProductEdit & { field: 'stock' }, shown: string): Promise<VariantUpdateInput | string | null> {
  const fresh = await freshStock(context, variantId);
  if (!fresh) return PRODUCT_SAVE_FAILED_TEXT;
  return String(fresh.saleable) === shown ? variantUpdateInput(variantId, { ...edit, target: fresh.target }, '') : STOCK_CHANGED_TEXT;
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
/** 10.2: the stock edit as one compare-and-set on the plugin's POST /tally/v1/variants/:id/stock (plugin README). null: saved; text: why not; false: a plugin without the route (a 404 with no `code`), so the caller takes checkStockEdit + saveVariantUpdate. */
export async function saveStock(context: SyncContext, variantId: string, shown: string, text: string): Promise<string | null | false> {
  try {
    const saleable = Number(text.trim());
    const response = await fetch(`${context.baseUrl}/tally/v1/variants/${encodeURIComponent(variantId)}/stock`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ expectedSaleable: Number(shown), saleable }) });
    if (response.status === 401 || response.status === 403) return PRODUCT_SAVE_FORBIDDEN_TEXT;
    const body = await response.json().catch(() => null);
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (response.status === 404 && !code) return false;
    // Saved only when the route echoes the figure sent: a 200 from anything else (a proxy's HTML page) wrote nothing.
    if (response.ok) return body?.saleable === saleable ? null : PRODUCT_SAVE_FAILED_TEXT;
    // The store already holds the figure sent (a resend after a lost answer): the edit is saved.
    if (response.status === 409 && code === 'stock_changed') return body.saleable === saleable ? null : STOCK_CHANGED_TEXT;
    return PRODUCT_SAVE_FAILED_TEXT;
  } catch { return PRODUCT_SAVE_FAILED_TEXT; }
}
