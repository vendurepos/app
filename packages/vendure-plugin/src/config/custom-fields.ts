import type { CustomFieldConfig } from '@vendure/core';

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
// tallyClientOrderId its index; the migration adds the plain register and session indexes.
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
