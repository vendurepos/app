import type { OrderCreatePayload } from '../vendored/commands';

// Postgres int4, the column type of every Vendure money field: a larger value would fail after
// the claim instead of being refused before it (review 3).
export const MAX_MINOR = 2_147_483_647;
// Vendure's default varchar length for the string custom fields and the ledger's columns.
export const MAX_STRING = 255;

/**
 * Range errors of a payload whose shape is already valid (payloadShapeErrors), answered as
 * `invalid_payload` before the claim; [] when every value fits.
 */
export function valueRangeErrors(payload: OrderCreatePayload): string[] {
  const errors: string[] = [];
  const minor = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || (value as number) < 0) errors.push(`${path}: expected a non-negative integer`);
    else if ((value as number) > MAX_MINOR) errors.push(`${path}: expected at most ${MAX_MINOR}`);
  };
  const text = (value: unknown, path: string, max = MAX_STRING) => {
    if (typeof value === 'string' && value.length > max) errors.push(`${path}: expected at most ${max} characters`);
  };
  for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor', 'discountMinor'] as const) minor(payload[field], field);
  for (const field of ['clientOrderId', 'registerId', 'cashierRef', 'sessionId'] as const) text(payload[field], field);
  text(payload.customer?.customerId, 'customer.customerId', 64);
  payload.lines.forEach((line, index) => {
    const path = `lines[${index}]`;
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) errors.push(`${path}.quantity: expected a positive integer`);
    for (const field of ['unitPriceMinor', 'discountMinor'] as const) minor(line[field], `${path}.${field}`);
    text(line.clientLineId, `${path}.clientLineId`);
  });
  payload.payments.forEach((payment, index) => {
    const path = `payments[${index}]`;
    for (const field of ['amountMinor', 'tenderedMinor', 'changeMinor'] as const) minor(payment[field], `${path}.${field}`);
    for (const field of ['clientPaymentId', 'reference'] as const) text(payment[field], `${path}.${field}`);
  });
  return errors;
}
