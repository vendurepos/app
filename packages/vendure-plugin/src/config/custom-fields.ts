import { CustomOrderFields } from '@vendure/core';
import type { CustomFieldConfig } from '@vendure/core';
import { Index, getMetadataArgsStorage } from 'typeorm';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
  interface CustomOrderFields {
    tallyClientOrderId?: string | null;
    tallySaleAt?: Date | null;
    tallyRegisterId?: string | null;
    tallySessionId?: string | null;
    tallyCashierRef?: string | null;
    tallyPayments?: string | null;
    tallySnapshot?: string | null;
  }
  interface CustomOrderLineFields {
    tallyUnitPrice?: number | null;
    tallyClientLineId?: string | null;
    tallyPriceIncludesTax?: boolean | null;
  }
}

// ADR 0002 §3: read-only in the Admin API; the plugin writes them directly. `unique` gives
// tallyClientOrderId its index; registerOrderIndexes gives the register and session ids theirs.
export const orderCustomFields: CustomFieldConfig[] = [
  { name: 'tallyClientOrderId', type: 'string', unique: true, readonly: true, nullable: true },
  { name: 'tallySaleAt', type: 'datetime', readonly: true, nullable: true },
  { name: 'tallyRegisterId', type: 'string', readonly: true, nullable: true },
  { name: 'tallySessionId', type: 'string', readonly: true, nullable: true },
  { name: 'tallyCashierRef', type: 'string', readonly: true, nullable: true },
  { name: 'tallyPayments', type: 'text', readonly: true, nullable: true },
  { name: 'tallySnapshot', type: 'text', readonly: true, nullable: true },
];

export const orderLineCustomFields: CustomFieldConfig[] = [
  { name: 'tallyUnitPrice', type: 'int', readonly: true, nullable: true },
  { name: 'tallyClientLineId', type: 'string', readonly: true, nullable: true },
  { name: 'tallyPriceIncludesTax', type: 'boolean', readonly: true, nullable: true },
];

// Custom fields have no index option, so the plain indexes go on the CustomOrderFields embeddable
// as TypeORM metadata, as Vendure itself indexes unique custom fields on MySQL (ruling 2). TypeORM
// then knows them: schema sync creates them, and generateMigration neither drops nor re-adds them.
const orderIndexes = [
  { name: 'IDX_tally_order_register_id', field: 'tallyRegisterId' },
  { name: 'IDX_tally_order_session_id', field: 'tallySessionId' },
];

/** Idempotent: Vendure runs plugin configuration once for runMigrations and again for bootstrap. */
export function registerOrderIndexes() {
  const { indices } = getMetadataArgsStorage();
  for (const { name, field } of orderIndexes) {
    if (!indices.some(index => index.name === name)) Index(name)(CustomOrderFields.prototype, field);
  }
}
