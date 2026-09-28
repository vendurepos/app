import type { SyncContext } from '@tallyui/core';

/** A GraphQL field name, which is what a Vendure custom field name must be. */
export function isFieldName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** True when the store's ProductVariant has this custom field. Never rejects; false on any failure. */
export async function hasVariantCustomField(context: SyncContext, field: string): Promise<boolean> {
  try {
    const response = await fetch(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal,
      body: JSON.stringify({ query: `{ productVariants(options: { take: 1 }) { items { customFields { ${field} } } } }` }),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return !body.errors && body.data?.productVariants != null;
  } catch {
    return false;
  }
}
