// The one walk-in placeholder customer shared by every channel. Its own module, so StoreSetupService and
// OrderCreateService share it without importing each other.
export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';

// ADR 0005 ruling (a): the plugin-owned variant for custom till lines.
export const TALLY_CUSTOM_ITEM_SKU = 'TALLY-CUSTOM-ITEM';
// ADR 0005 ruling (a): the plugin-owned category for untaxed custom lines.
export const TALLY_NO_TAX_CATEGORY = 'POS no tax';

// The order.create versions the server accepts (the plugin's own list; nothing is vendored for it). 6 (ADR-077) is
// accepted with coupons and Any picks refused and regular prices and line attributes display only; 7 (ADR-083) adds
// the sale note, kept as a public Vendure order note (P2.11a). 8, 9 and 10 are accepted for their shape only (3.2a-1):
// their new fields (v8 taxAddress and customer addresses, v9 coupon lines, v10 payments[].methodId) are refused as not
// supported (strict-shape.ts), so a sale that does not send them is taken as a version 7 sale.
export const ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Fees, shipping and custom lines are honoured (ADR 0005), so /tally/v1/info advertises every accepted version.
export const ADVERTISED_ORDER_CREATE_VERSIONS: readonly number[] = ORDER_CREATE_VERSIONS;

// The register contract versions this plugin implements (ADR 0003), shared by the five register.* commands; /info
// advertises this list and RegisterService's version gate reads it. Version 2 is ADR-078's take-over and resume; 3 (ADR-082)
// adds the closure's manager approval proof.
export const REGISTER_VERSIONS: readonly number[] = [1, 2, 3];

// medusapos ADR 0023: an issued approval proof is good for 15 minutes, then a v3 closure refuses it as expired.
export const APPROVAL_TTL_MS = 15 * 60_000;
// medusapos ADR 0023: failed approval requests (never issued) count towards the limits for 15 minutes.
export const APPROVAL_FAILURE_WINDOW_MS = 15 * 60_000;
// medusapos ADR 0023: failed approvals per requesting cashier in the window; the next request is approval_rate_limited.
export const MAX_APPROVAL_FAILURES_PER_ACTOR = 5;
// medusapos ADR 0023: failed approvals per manager username in the window, across cashiers.
export const MAX_APPROVAL_FAILURES_PER_IDENTIFIER = 10;

// ADR 0007: the order.refund versions this plugin implements; /info advertises them and RefundService gates on them.
export const ORDER_REFUND_VERSIONS: readonly number[] = [1];

// ADR 0005 ruling (b): one shipping charge per order. /tally/v1/info advertises it and the strict shape check enforces it.
export const MAX_SHIPPING_LINES = 1;

// The SKUs of the surcharges order.create writes (ADR 0005): a fee, a line discount and the tax rounding bridge.
// They are stored on orders, and order.create's fiscal check reads the fee and discount back, so they never change.
export const TALLY_FEE_SKU = 'TALLY-FEE';
export const TALLY_DISCOUNT_SKU = 'TALLY-DISCOUNT';
export const TALLY_ROUNDING_SKU = 'TALLY-ROUNDING';

// Postgres two-int advisory lock namespaces: (namespace, key) keys stay apart from other plugins' single-bigint keys,
// and these three must stay distinct from each other.
// StoreSetupService: the key (SETUP_LOCK_NAMESPACE, 0) is deliberately global, not per channel: the POS methods and
// the walk-in are rows shared by every channel.
export const SETUP_LOCK_NAMESPACE = 0x7a11;
// Ruling 14: (CUSTOMER_LOCK_NAMESPACE, hashtext(email)) serialises creating a customer per email.
export const CUSTOMER_LOCK_NAMESPACE = 0x7a12;
// ADR 0003: (REGISTER_LOCK_NAMESPACE, hashtext of the channel and register) serialises a register's commands across
// tills and instances.
export const REGISTER_LOCK_NAMESPACE = 0x7a13;
