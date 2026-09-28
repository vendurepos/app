import type { SyncContext } from '@tallyui/core';

/** A GraphQL field name, which is what a Vendure custom field name must be. */
export function isFieldName(name: string): boolean {
  return !name.startsWith('__') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export type BarcodeFieldCheck = 'ok' | 'missing' | 'wrong_type' | { error: string };
export async function checkBarcodeField(context: SyncContext, field: string): Promise<BarcodeFieldCheck> {
  try {
    const response = await fetch(`${context.baseUrl}/admin-api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
      signal: context.signal,
      body: JSON.stringify({ query: '{ globalSettings { serverConfig { entityCustomFields { entityName customFields { ... on CustomField { name type list } } } } } }' }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    const entities = body.data.globalSettings.serverConfig.entityCustomFields as {
      entityName: string; customFields: { name: string; type: string; list: boolean }[];
    }[];
    const customField = entities.find((entry) => entry.entityName === 'ProductVariant')?.customFields.find((entry) => entry.name === field);
    return !customField ? 'missing' : customField.list === false && ['string', 'text'].includes(customField.type) ? 'ok' : 'wrong_type';
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
