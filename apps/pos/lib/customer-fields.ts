import { useEffect, useState } from 'react';
import type { SyncContext } from '@tallyui/core';
import { sessionContext, type Session } from './session';
// Vendure keeps a tax ID and other customer data as Customer custom fields, shown read-only as v2 shows a tax ID.
export type CustomerFieldDef = { name: string; label: string; type: string; list: boolean };
export type CustomerFieldRow = { name: string; label: string; value: string };
export const CUSTOMER_FIELD_CONFIG_QUERY = 'query CustomerCustomFieldConfig { globalSettings { serverConfig { entityCustomFields { entityName customFields { ... on CustomField { name type list internal label { languageCode value } } } } } } }';
export const CUSTOMER_FIELD_EMPTY = '—';
export function customerFieldDefs(entities: { entityName: string; customFields: { name: string; type: string; list: boolean; internal?: boolean | null; label?: { languageCode: string; value: string }[] | null }[] }[]): CustomerFieldDef[] {
  return (entities.find(entity => entity.entityName === 'Customer')?.customFields ?? [])
    .filter(field => !field.internal && field.type !== 'relation' && field.type !== 'struct' && /^[_A-Za-z][_0-9A-Za-z]*$/.test(field.name))
    .map(field => ({ name: field.name, label: field.label?.find(label => label.languageCode === 'en')?.value ?? field.label?.[0]?.value ?? field.name, type: field.type, list: field.list }));
}
export function customerFieldsQuery(defs: CustomerFieldDef[]): string {
  return `query CustomerCustomFields($id: ID!) { customer(id: $id) { id customFields { ${defs.map(d => d.name).join(' ')} } } }`;
}
export function customerFieldValue(def: CustomerFieldDef, raw: unknown): string {
  if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) return CUSTOMER_FIELD_EMPTY;
  const format = (v: unknown): string => def.type === 'boolean' ? (v ? 'Yes' : 'No')
    : def.type === 'datetime' ? new Date(v as string).toLocaleDateString(undefined, { dateStyle: 'medium' }) : String(v);
  return def.list ? (raw as unknown[]).map(format).join(', ') : format(raw);
}
async function adminRead(context: SyncContext, query: string, variables?: { id: string }) {
  const response = await fetch(`${context.baseUrl}/admin-api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...context.headers },
    signal: context.signal, body: JSON.stringify({ query, variables }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json(); if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}
export async function readCustomerFields(context: SyncContext, customerId: string): Promise<CustomerFieldRow[] | null> {
  const config = await adminRead(context, CUSTOMER_FIELD_CONFIG_QUERY);
  const defs = customerFieldDefs(config.globalSettings.serverConfig.entityCustomFields);
  if (defs.length === 0) return [];
  const { customer } = await adminRead(context, customerFieldsQuery(defs), { id: customerId });
  return customer === null ? null : defs.map(def => ({ name: def.name, label: def.label, value: customerFieldValue(def, customer.customFields?.[def.name]) }));
}
export function useCustomerFields(session: Session, customerId: string | null): CustomerFieldRow[] | null {
  const [fields, setFields] = useState<CustomerFieldRow[] | null>(null);
  useEffect(() => {
    setFields(null); if (customerId === null) return;
    let cancelled = false;
    void readCustomerFields(sessionContext(session), customerId).then(found => { if (!cancelled) setFields(found); }, () => {});
    return () => { cancelled = true; };
  }, [session, customerId]);
  return fields;
}
