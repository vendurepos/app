// vendurepos addition, ruling 17; to be upstreamed to @tallyui/core/server.
// Front desk ruling 17 (ADR 0002 §5): a field the command's version does not know, misspelt or from a later version,
// is an unstored invalid_payload in step 4 (after the replay read, so a stored answer wins), since a money field
// accepted and ignored (v1 `discountMinor`) would charge the full price for a sale the till discounted. The contract
// declares no free-form map inside order.create.
import { MAX_SHIPPING_LINES } from './constants';

type Fields = Record<string, number>;
// Each field with the version that introduced it, from src/vendored/commands.ts (`locationId`, declared unversioned, is refused below).
const since = (version: number, names: string): Fields => Object.fromEntries(names.split(' ').map(name => [name, version]));
const ENVELOPE = since(1, 'id type version createdAt deviceId attempt payload');

export function refundEnvelopeStrictErrors(command: Record<string, unknown>, version: number): string[] {
  return Object.keys(command).filter(key => !Object.hasOwn(ENVELOPE, key)).slice(0, 10)
    .map(key => `envelope.${key}: unknown field in order.refund version ${version}`);
}

const PAYLOAD = {
  ...since(1, 'clientOrderId createdAt currency pricesIncludeTax lines subtotalMinor taxMinor totalMinor payments customer registerId cashierRef locationId'),
  discountMinor: 2, ...since(3, 'display taxByRate sessionId'), ...since(5, 'fees shipping'), ...since(6, 'coupons'), note: 7, taxAddress: 8,
  cashRoundings: 1,
};
const LINE = { ...since(1, 'clientLineId variantId title quantity unitPriceMinor taxInclusive'), discountMinor: 2, custom: 5,
  ...since(6, 'regularUnitPriceMinor attributes anyAttributes') };
const FEE = since(1, 'clientFeeId name amountMinor amountIncludesTax taxStatus taxClass taxMinor');
const SHIPPING = since(1, 'clientShippingId name methodId amountMinor amountIncludesTax taxStatus taxClass taxMinor');
const LINE_CUSTOM = since(1, 'name sku taxClass taxStatus');
const PAYMENT = { ...since(1, 'clientPaymentId method amountMinor tenderedMinor changeMinor reference'), methodId: 10 };
// TallyUI ADR-094: core has no version gate on cashRoundings, so it is accepted at every version.
const CASH_ROUNDING = since(1, 'paymentId minor');
const CUSTOMER = { email: 1, customerId: 3, billing: 8, shipping: 8 };
// v11 (5.2a): the fields of customer.billing and customer.shipping, declared with the addresses at version 8.
const ADDRESS = since(8, 'firstName lastName company address1 address2 city state postcode country phone');
// Coupons are refused below; the table names v9's `lines`, so it reads "not supported", never "unknown field".
const COUPON = { ...since(6, 'code couponId discountMinor discountTaxMinor'), lines: 9 };
// Inside v3's `display` and `taxByRate` (their parents carry the version).
const DISPLAY = { ...since(1, 'currency exponent taxInclusive subtotalMinor discountMinor taxMinor totalMinor orderDiscountMinor lines'), fees: 5, shipping: 5, coupons: 6 };
const DISPLAY_FEE = since(1, 'clientFeeId amountMinor');
const DISPLAY_SHIPPING = since(1, 'clientShippingId amountMinor');
const DISPLAY_LINE = since(1, 'clientLineId amountMinor discounts');
const DISPLAY_DISCOUNT = since(1, 'discountId label amountMinor');
const TAX_RATE = since(1, 'ratePpm code netMinor taxMinor grossMinor');

/** Fields the command's version does not know, by full path, e.g. 'lines[2].discountMinr: unknown field in
 * order.create version 1' or 'discountMinor: requires order.create version 2, command is version 1'; [] when none.
 * Payload paths are relative to the payload, as in payloadShapeErrors; envelope fields read `envelope.<field>`. */
export function strictShapeErrors(command: Record<string, unknown>, version: number): string[] {
  const errors: string[] = [];
  const full = () => errors.length >= 10; // The cap, for every push.
  const check = (value: unknown, fields: Fields, path: string): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    for (const key of Object.keys(value)) {
      const at = path ? `${path}.${key}` : key;
      const first = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (full()) break;
      if (first === undefined) errors.push(`${at}: unknown field in order.create version ${version}`);
      else if (first > version) errors.push(`${at}: requires order.create version ${first}, command is version ${version}`);
    }
    return true;
  };
  const each = (items: unknown, fields: Fields, path: string, then?: (item: Record<string, unknown>, at: string) => void) =>
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      if (check(item, fields, `${path}[${index}]`)) then?.(item, `${path}[${index}]`);
    });
  check(command, ENVELOPE, 'envelope');
  const payload = command.payload;
  if (!check(payload, PAYLOAD, '')) return errors;
  // Front desk ruling 19: an instruction field, refused in every version until it is honoured: vendurepos/app#35
  // (ADR 0002 "Stock", §5).
  if (Object.hasOwn(payload, 'locationId') && !full()) errors.push('payload.locationId: not supported by this server yet');
  // P2.11a: coupons and Any picks (order.create 6) are refused until this server honours them; v6's regular prices and
  // line attributes are display only (value-ranges.ts checks them, nothing reads them), so no amount depends on them.
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const unsupported = (path: string) => { if (!full()) errors.push(`${path}: not supported by this server`); };
  if (Object.hasOwn(payload, 'coupons')) unsupported('coupons');
  if (isObject(payload.display) && Object.hasOwn(payload.display, 'coupons')) unsupported('display.coupons');
  (Array.isArray(payload.lines) ? payload.lines : []).forEach((line, index) => {
    if (isObject(line) && Object.hasOwn(line, 'anyAttributes')) unsupported(`lines[${index}].anyAttributes`);
  });
  // 3.2a-1: v8's tax address is refused until this server honours it; the customer addresses are refused before 11 and
  // honoured from 11 (5.2a), each checked field by field.
  if (Object.hasOwn(payload, 'taxAddress')) unsupported('taxAddress');
  for (const field of ['billing', 'shipping']) {
    if (!isObject(payload.customer) || !Object.hasOwn(payload.customer, field)) continue;
    if (version >= 11) check(payload.customer[field], ADDRESS, `customer.${field}`);
    else unsupported(`customer.${field}`);
  }
  each(payload.lines, LINE, 'lines', (line, at) => check(line.custom, LINE_CUSTOM, `${at}.custom`));
  each(payload.fees, FEE, 'fees');
  each(payload.shipping, SHIPPING, 'shipping');
  each(payload.coupons, COUPON, 'coupons');
  each(payload.payments, PAYMENT, 'payments');
  each(payload.cashRoundings, CASH_ROUNDING, 'cashRoundings');
  check(payload.customer, CUSTOMER, 'customer');
  if (check(payload.display, DISPLAY, 'display')) {
    each(payload.display.lines, DISPLAY_LINE, 'display.lines', (line, at) => each(line.discounts, DISPLAY_DISCOUNT, `${at}.discounts`));
    each(payload.display.fees, DISPLAY_FEE, 'display.fees');
    each(payload.display.shipping, DISPLAY_SHIPPING, 'display.shipping');
  }
  each(payload.taxByRate, TAX_RATE, 'taxByRate');
  if (Array.isArray(payload.shipping) && payload.shipping.length > MAX_SHIPPING_LINES && !full()) {
    errors.push('shipping[1]: shipping_single: this store takes one shipping charge per order');
  }
  return errors;
}

// ADR-070 d1 for the register commands (ADR 0003), until core checks fields (TallyUI #255) and map keys (#256): each
// type's version 1 fields, and the declared maps' keys, PaymentMethodKind, both declared at version 1.
const REGISTER_PAYLOADS: Record<string, Fields> = {
  'register.session.open': { ...since(1, 'sessionId registerId storeKey businessDay openedAt openedBy expectedFloatMinor countedFloatMinor openingVarianceMinor'), ...since(2, 'deviceName supersedes') },
  'register.session.transition': since(1, 'sessionId status at counted closedBy approvedBy'),
  'register.movement.record': since(1, 'movementId sessionId type amountMinor reason createdAt createdBy'),
  'register.movement.void': since(1, 'movementId sessionId voids createdAt createdBy'),
  'register.closure.submit': { ...since(1, 'closureId sessionId registerId number businessDay openedAt closedAt closedBy approvedBy tillExpected '
    + 'counted periodSalesTotalMinor periodRefundsTotalMinor perpetualSalesTotalMinor perpetualRefundsTotalMinor unsyncedCount '
    + 'unsyncedTotalMinor softwareVersion orderIds movementIds'), ...since(3, 'approval') },
};
const METHOD_KINDS = since(1, 'cash external');

/** A register command's unknown fields and map keys by path, worded as strictShapeErrors words them, e.g.
 * 'counted.card: unknown key in register.closure.submit version 1'; [] when none. The payload's shape is already valid. */
export function registerStrictErrors(command: Record<string, unknown>, type: string, version: number): string[] {
  const errors: string[] = [];
  const check = (value: object, fields: Fields, path: string, what: string) => {
    for (const key of Object.keys(value)) {
      const at = path ? `${path}.${key}` : key;
      const first = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (errors.length >= 10) break;
      if (first === undefined) errors.push(`${at}: unknown ${what} in ${type} version ${version}`);
      else if (first > version) errors.push(`${at}: requires ${type} version ${first}, command is version ${version}`);
    }
  };
  check(command, ENVELOPE, 'envelope', 'field');
  const payload = command.payload as Record<string, object | undefined>;
  check(payload, REGISTER_PAYLOADS[type], '', 'field');
  for (const map of ['counted', 'tillExpected']) if (payload[map]) check(payload[map], METHOD_KINDS, map, 'key');
  // Register v3's opaque manager proof (ADR-082): a string, never parsed.
  const approval: unknown = payload.approval;
  if (type === 'register.closure.submit' && approval !== undefined && (typeof approval !== 'string' || !approval.length)) {
    errors.push('approval: expected a non-empty string');
  }
  return errors;
}
