import type { OrderCreatePayload } from '../vendored/commands';

// Postgres int4: the column type of the default MoneyStrategy's money columns, of the
// tallyUnitPrice `int` custom field and of OrderLine.quantity. A larger value would fail after the
// claim instead of being refused before it (review 3).
export const MAX_INT4 = 2_147_483_647;
// Vendure's default varchar length for the string custom fields and the ledger's columns.
export const MAX_STRING = 255;
// The customerId bound both plugins share; a longer one is ignored, never refused.
export const CUSTOMER_ID_MAX = 64;

/**
 * The largest amount the store's money columns hold (N2): int4 for the default MoneyStrategy, and
 * the safe-integer range for a strategy with bigint columns (BigIntMoneyStrategy).
 */
export function maxMoneyMinor(moneyColumnType: unknown): number {
  return moneyColumnType === 'bigint' || moneyColumnType === 'int8' ? Number.MAX_SAFE_INTEGER : MAX_INT4;
}

/**
 * Range errors of a payload whose shape is already valid (payloadShapeErrors), answered as
 * `invalid_payload` before the claim; [] when every value fits. `maxMoney` bounds the amounts that
 * land in the store's money columns (maxMoneyMinor).
 */
export function valueRangeErrors(payload: OrderCreatePayload, maxMoney: number): string[] {
  const errors: string[] = [];
  const minor = (value: unknown, path: string, max: number) => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || (value as number) < 0) errors.push(`${path}: expected a non-negative integer`);
    else if ((value as number) > max) errors.push(`${path}: expected at most ${max}`);
  };
  const text = (value: unknown, path: string, max = MAX_STRING) => {
    if (typeof value === 'string' && value.length > max) errors.push(`${path}: expected at most ${max} characters`);
  };
  // N3: tallySaleAt and orderPlacedAt are written from it after the claim.
  if (!Number.isFinite(Date.parse(payload.createdAt))) errors.push('createdAt: expected a date');
  for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor', 'discountMinor'] as const) minor(payload[field], field, maxMoney);
  for (const field of ['clientOrderId', 'registerId', 'cashierRef', 'sessionId'] as const) text(payload[field], field);
  // customerId over CUSTOMER_ID_MAX is never refused: the recipe treats it as absent (customer_ignored).
  // The bound both plugins share (RFC 5321's 254), inside Vendure's varchar(255) emailAddress.
  text(payload.customer?.email, 'customer.email', 254);
  payload.lines.forEach((line, index) => {
    const path = `lines[${index}]`;
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) errors.push(`${path}.quantity: expected a positive integer`);
    else if (line.quantity > MAX_INT4) errors.push(`${path}.quantity: expected at most ${MAX_INT4}`);
    minor(line.unitPriceMinor, `${path}.unitPriceMinor`, MAX_INT4);
    minor(line.discountMinor, `${path}.discountMinor`, maxMoney);
    text(line.clientLineId, `${path}.clientLineId`);
  });
  payload.payments.forEach((payment, index) => {
    const path = `payments[${index}]`;
    minor(payment.amountMinor, `${path}.amountMinor`, maxMoney);
    // Stored only in the tallyPayments text.
    for (const field of ['tenderedMinor', 'changeMinor'] as const) minor(payment[field], `${path}.${field}`, Number.MAX_SAFE_INTEGER);
    for (const field of ['clientPaymentId', 'reference'] as const) text(payment[field], `${path}.${field}`);
  });
  return errors;
}
